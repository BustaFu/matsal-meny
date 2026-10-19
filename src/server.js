'use strict';
/*
 * Matsal-menyn
 *
 * Public:
 *   GET  /                 -> kiosk display
 *   GET  /display          -> kiosk display
 *   GET  /api/menu/today   -> today's resolved menu
 *   GET  /api/menu/:date   -> resolved menu for a date
 *   GET  /api/allergen-labels
 *
 * Admin (x-admin-token required):
 *   GET  /api/dishes
 *   GET  /api/schedule
 *   POST /api/dishes
 *   PUT/DELETE /api/dishes/:id
 *   PUT /api/schedule/weekday/:wd
 *   PUT/DELETE /api/schedule/week/:key
 *   PUT /api/schedule/week/:key/:wd
 *   PUT/DELETE /api/schedule/override/:date
 *   PUT /api/display
 *   POST /api/images/:name
 *   POST /api/admin/verify
 *
 * Environment:
 *   PORT
 *   ADMIN_TOKEN (required; at least 32 bytes)
 *   BASE_PATH (default /meny; empty string for root)
 *   TZ should be Europe/Stockholm in the deployment environment.
 */
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'meals.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const IMAGES_DIR = path.join(ROOT, 'images');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const MAX_MEALS_PER_DAY = 3;
const MAX_IMAGE_BYTES = 4_000_000;
const MAX_IMAGE_PIXELS = 20_000_000;
const MAX_IMAGE_DIMENSION = 8000;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}
if (
  typeof ADMIN_TOKEN !== 'string' ||
  Buffer.byteLength(ADMIN_TOKEN, 'utf8') < 32
) {
  throw new Error(
    'ADMIN_TOKEN must be configured and contain at least 32 bytes'
  );
}

const RAW_BASE = (process.env.BASE_PATH ?? '/meny')
  .trim()
  .replace(/\/+$/, '');
if (RAW_BASE && !/^\/[a-zA-Z0-9/_-]+$/.test(
  RAW_BASE.startsWith('/') ? RAW_BASE : `/${RAW_BASE}`
)) {
  throw new Error('BASE_PATH contains unsupported characters');
}
const BASE_PATH = RAW_BASE
  ? (RAW_BASE.startsWith('/') ? RAW_BASE : `/${RAW_BASE}`)
  : '';

const VECKODAGAR = [
  null, 'Måndag', 'Tisdag', 'Onsdag',
  'Torsdag', 'Fredag', 'Lördag', 'Söndag'
];

const ALLERGEN_ETIKETTER = Object.freeze({
  gluten: 'Gluten',
  skalddjur: 'Skaldjur',
  agg: 'Ägg',
  fisk: 'Fisk',
  jordnot: 'Jordnöt',
  soja: 'Soja',
  mjolk: 'Mjölk',
  selleri: 'Selleri',
  senap: 'Senap',
  sesam: 'Sesam',
  svavel: 'Svaveldioxid/sulfiter',
  lupin: 'Lupin',
  blodskaldjur: 'Blötdjur'
});
const ALLOWED_ALLERGENS = new Set(
  Object.keys(ALLERGEN_ETIKETTER)
);
const ALLOWED_IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp'
]);
const MAX_TEXT_LENGTH = 5000;
const MAX_NAME_LENGTH = 200;
const MAX_ID_LENGTH = 80;
const MAX_TAGS = 30;
const MAX_ALLERGENS = 14;

let store;
let writeQueue = Promise.resolve();

/* ---------------- initialization ---------------- */

function ensureDirectories() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  for (const file of [PUBLIC_DIR]) {
    if (!fs.existsSync(file) || !fs.statSync(file).isDirectory()) {
      throw new Error(`Required directory missing: ${file}`);
    }
  }
}

function validateLoadedStore(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('meals.json must contain a JSON object');
  }
  data.dishes ??= [];
  data.schedule ??= {};
  data.schedule.weekdays ??= {};
  data.schedule.overrides ??= {};
  data.schedule.weeks ??= {};
  data.display ??= {};
  if (
    !Array.isArray(data.dishes) ||
    !data.schedule || typeof data.schedule !== 'object' ||
    Array.isArray(data.schedule) ||
    !data.schedule.weekdays ||
    typeof data.schedule.weekdays !== 'object' ||
    Array.isArray(data.schedule.weekdays) ||
    !data.schedule.overrides ||
    typeof data.schedule.overrides !== 'object' ||
    Array.isArray(data.schedule.overrides) ||
    !data.schedule.weeks ||
    typeof data.schedule.weeks !== 'object' ||
    Array.isArray(data.schedule.weeks) ||
    !data.display ||
    typeof data.display !== 'object' ||
    Array.isArray(data.display)
  ) {
    throw new Error('meals.json has an invalid structure');
  }
  const seen = new Set();
  for (const dish of data.dishes) {
    if (
      !dish ||
      typeof dish !== 'object' ||
      typeof dish.id !== 'string' ||
      typeof dish.name !== 'string' ||
      !dish.id ||
      !dish.name
    ) {
      throw new Error('meals.json contains an invalid dish');
    }
    if (seen.has(dish.id)) {
      throw new Error(`Duplicate dish ID: ${dish.id}`);
    }
    seen.add(dish.id);
  }
  return data;
}

function loadStore() {
  try {
    store = validateLoadedStore(
      JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
    );
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`Cannot load ${DATA_FILE}: ${err.message}`);
    }
    store = validateLoadedStore({
      dishes: [],
      schedule: {
        weekdays: {},
        overrides: {},
        weeks: {}
      },
      display: {}
    });
    saveStoreSync();
  }
}

/* ---------------- persistent storage ---------------- */

/*
 * Writes a complete JSON snapshot to a temporary file and renames it.
 * Keep the data directory on a filesystem supporting atomic rename.
 */
function saveStoreSync() {
  const tmp = path.join(
    DATA_DIR,
    `.meals-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(store, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/*
 * Serializes mutations and persistence. This protects against concurrent
 * asynchronous handlers in this process, but not multiple Node processes
 * writing the same JSON file.
 */
function mutateStore(mutator) {
  const operation = writeQueue.then(() => {
    const previous = JSON.stringify(store);
    mutator();
    try {
      saveStoreSync();
    } catch (err) {
      store = JSON.parse(previous);
      throw err;
    }
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

function dishById(id) {
  return store.dishes.find(dish => dish.id === id);
}

/* ---------------- date and ISO week helpers ---------------- */

function todayStr() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function isValidDateString(value) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function isoVeckodag(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return ((date.getUTCDay() + 6) % 7) + 1;
}

function isoVeckaNyckel(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(
    ((date - yearStart) / 86400000 + 1) / 7
  );
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

function weeksInYear(year) {
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const leap = (year % 4 === 0 && year % 100 !== 0) ||
    year % 400 === 0;
  return jan1.getUTCDay() === 4 ||
    (leap && jan1.getUTCDay() === 3) ? 53 : 52;
}

function veckonyckel(key) {
  const match = /^(\d{4})-W(\d{2})$/.exec(String(key));
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (year < 1 || week < 1 || week > weeksInYear(year)) {
    return null;
  }
  return { ar: year, vecka: week };
}

/* ---------------- menu resolution ---------------- */

function menuFor(dateStr) {
  const weekday = isoVeckodag(dateStr);
  const weekKey = isoVeckaNyckel(dateStr);
  const override = store.schedule.overrides[dateStr];
  const weekDay = (store.schedule.weeks[weekKey] || {})[
    String(weekday)
  ];

  let ids;
  let source;
  if (override !== undefined) {
    ids = override;
    source = 'override';
  } else if (weekDay !== undefined) {
    ids = weekDay;
    source = 'vecka';
  } else {
    ids = store.schedule.weekdays[String(weekday)] || [];
    source = 'veckodag';
  }

  if (!Array.isArray(ids)) ids = [];
  const dishes = [...new Set(ids)]
    .map(id => {
      const dish = dishById(id);
      if (!dish) {
        console.warn(`[meny] Unknown dish ID "${id}" on ${dateStr}`);
      }
      return dish;
    })
    .filter(Boolean)
    .slice(0, MAX_MEALS_PER_DAY);

  return {
    date: dateStr,
    weekday,
    weekdayName: VECKODAGAR[weekday],
    week: weekKey,
    source,
    dishes,
    display: store.display,
    updatedAt: new Date().toISOString()
  };
}

/* ---------------- input validation ---------------- */

function normalizeId(value) {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ID_LENGTH);
}

function stringField(value, field, maxLength = MAX_TEXT_LENGTH) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > maxLength) {
    throw httpError(400, `${field} must be a string of at most ${maxLength} characters`);
  }
  return value.trim();
}

function normalizeDish(body, forcedId) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'Request body must be an object');
  }
  const rawId = forcedId !== undefined ? forcedId : body.id;
  const id = normalizeId(rawId);
  if (!id) throw httpError(400, 'id is required');
  if (typeof body.name !== 'string' || !body.name.trim()) {
    throw httpError(400, 'name is required');
  }
  if (body.name.trim().length > MAX_NAME_LENGTH) {
    throw httpError(400, 'name is too long');
  }
  if (body.allergens !== undefined && !Array.isArray(body.allergens)) {
    throw httpError(400, 'allergens must be an array');
  }
  if (body.tags !== undefined && !Array.isArray(body.tags)) {
    throw httpError(400, 'tags must be an array');
  }
  const allergens = body.allergens || [];
  const tags = body.tags || [];
  if (allergens.length > MAX_ALLERGENS || tags.length > MAX_TAGS) {
    throw httpError(400, 'Too many allergens or tags');
  }
  if (!allergens.every(
    item => typeof item === 'string' && ALLOWED_ALLERGENS.has(item)
  )) {
    throw httpError(400, 'allergens contains an unknown value');
  }
  if (!tags.every(
    item => typeof item === 'string' && item.length <= 100
  )) {
    throw httpError(400, 'tags contains an invalid value');
  }
  let price = body.price ?? null;
  if (price !== null) {
    if (
      typeof price !== 'number' ||
      !Number.isFinite(price) ||
      price < 0 ||
      price > 100000
    ) {
      throw httpError(400, 'price must be a valid non-negative number or null');
    }
  }
  const image = stringField(body.image, 'image', 255);
  if (image && (
    image.includes('/') ||
    image.includes('\\') ||
    image === '.' ||
    image === '..'
  )) {
    throw httpError(400, 'image must be a filename, not a path');
  }
  return {
    id,
    name: body.name.trim(),
    description: stringField(body.description, 'description'),
    ingredients: stringField(body.ingredients, 'ingredients'),
    allergens: [...new Set(allergens)],
    tags: [...new Set(tags.map(tag => tag.trim()))],
    price,
    image,
    origin: stringField(body.origin, 'origin', 500)
  };
}

function validatedDishIds(body) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !Array.isArray(body.dishIds)
  ) {
    throw httpError(400, 'dishIds must be an array');
  }
  if (body.dishIds.length > MAX_MEALS_PER_DAY) {
    throw httpError(400, `Maximum ${MAX_MEALS_PER_DAY} dishes per day`);
  }
  if (!body.dishIds.every(
    id => typeof id === 'string' && id.trim()
  )) {
    throw httpError(400, 'dishIds contains an invalid value');
  }
  const ids = body.dishIds.map(id => id.trim());
  if (new Set(ids).size !== ids.length) {
    throw httpError(400, 'Duplicate dish IDs are not allowed');
  }
  const unknown = ids.filter(id => !dishById(id));
  if (unknown.length) {
    throw httpError(400, `Unknown dish IDs: ${unknown.join(', ')}`);
  }
  return ids;
}

function validateDisplay(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'Display settings must be an object');
  }
  if (Object.keys(body).length > 50) {
    throw httpError(400, 'Too many display settings');
  }
  for (const [key, value] of Object.entries(body)) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(key)) {
      throw httpError(400, `Invalid display setting key: ${key}`);
    }
    if (
      !['string', 'number', 'boolean'].includes(typeof value) ||
      (typeof value === 'string' && value.length > 1000) ||
      (typeof value === 'number' && !Number.isFinite(value))
    ) {
      throw httpError(400, `Invalid display setting: ${key}`);
    }
  }
  return body;
}

/* ---------------- authentication ---------------- */

function isAdmin(req) {
  const supplied = req.get('x-admin-token');
  if (typeof supplied !== 'string') return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(ADMIN_TOKEN, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(401).json({
      error: 'Missing or invalid x-admin-token'
    });
  }
  next();
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/* ---------------- Express configuration ---------------- */

const app = express();
const mat = express.Router();

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      // UI uses inline scripts/styles; kiosk runs over plain HTTP on the LAN
      'script-src': ["'self'", "'unsafe-inline'"],
      'upgrade-insecure-requests': null
    }
  }
}));

/*
 * Image requests get their own JSON parser and limit.
 * All other JSON requests are limited to 256 KiB.
 */
app.use(express.json({
  limit: '256kb',
  type: req => !/\/api\/images\/[^/]+$/.test(req.path)
}));

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests; try again later' }
});
const imageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many image uploads; try again later' }
});

mat.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
mat.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return adminLimiter(req, res, next);
  }
  next();
});

function page(name) {
  return (req, res, next) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, name), err => {
      if (err) next(err);
    });
  };
}

mat.get('/', page('display.html'));
mat.get('/display', page('display.html'));
mat.get('/admin', page('admin.html'));
mat.use('/images', express.static(IMAGES_DIR, {
  maxAge: '1h',
  fallthrough: true,
  index: false,
  dotfiles: 'deny',
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}));

app.use(BASE_PATH || '/', mat);

if (BASE_PATH) {
  app.get('/', (req, res) => res.redirect(302, `${BASE_PATH}/`));
  app.get('/admin', (req, res) => res.redirect(302, `${BASE_PATH}/admin`));
}

function publicImageUrl(name) {
  return `${BASE_PATH}/images/${encodeURIComponent(name)}`;
}

/* ---------------- public menu API ---------------- */

mat.get('/api/menu/today', (req, res) => {
  res.json(menuFor(todayStr()));
});

mat.get('/api/menu/:date', (req, res) => {
  if (!isValidDateString(req.params.date)) {
    return res.status(400).json({
      error: 'date must be a valid YYYY-MM-DD calendar date'
    });
  }
  res.json(menuFor(req.params.date));
});

mat.get('/api/allergen-labels', (req, res) => {
  res.json(ALLERGEN_ETIKETTER);
});

/* ---------------- dishes (admin) ---------------- */

mat.get('/api/dishes', requireAdmin, (req, res) => {
  res.json(store.dishes);
});

mat.post('/api/dishes', requireAdmin, async (req, res) => {
  const dish = normalizeDish(req.body);
  if (dishById(dish.id)) {
    throw httpError(409, `Dish ${dish.id} already exists; use PUT`);
  }
  await mutateStore(() => {
    if (dishById(dish.id)) {
      throw httpError(409, `Dish ${dish.id} already exists; use PUT`);
    }
    store.dishes.push(dish);
  });
  res.status(201).json(dish);
});

mat.put('/api/dishes/:id', requireAdmin, async (req, res) => {
  const id = normalizeId(req.params.id);
  const dish = normalizeDish(req.body, req.params.id);
  if (dish.id !== id) {
    throw httpError(400, 'Invalid dish ID');
  }
  await mutateStore(() => {
    const index = store.dishes.findIndex(item => item.id === id);
    if (index === -1) throw httpError(404, 'Unknown dish ID');
    store.dishes[index] = dish;
  });
  res.json(dish);
});

mat.delete('/api/dishes/:id', requireAdmin, async (req, res) => {
  const id = normalizeId(req.params.id);
  await mutateStore(() => {
    if (!dishById(id)) throw httpError(404, 'Unknown dish ID');
    const references = [];
    for (const [date, ids] of Object.entries(store.schedule.overrides)) {
      if (Array.isArray(ids) && ids.includes(id)) references.push(date);
    }
    for (const [weekday, ids] of Object.entries(store.schedule.weekdays)) {
      if (Array.isArray(ids) && ids.includes(id)) {
        references.push(`weekday:${weekday}`);
      }
    }
    for (const [week, days] of Object.entries(store.schedule.weeks)) {
      for (const [weekday, ids] of Object.entries(days || {})) {
        if (Array.isArray(ids) && ids.includes(id)) {
          references.push(`${week}:${weekday}`);
        }
      }
    }
    if (references.length) {
      throw httpError(
        409,
        `Dish is still referenced by the schedule: ${references.slice(0, 10).join(', ')}`
      );
    }
    store.dishes = store.dishes.filter(item => item.id !== id);
  });
  res.json({ deleted: id });
});

/* ---------------- schedule helpers ---------------- */

function validWeekday(value) {
  if (!/^[1-7]$/.test(value)) {
    throw httpError(400, 'wd must be 1..7 (1 = Monday)');
  }
  return value;
}

function validWeekKey(value) {
  if (!veckonyckel(value)) {
    throw httpError(400, 'Invalid ISO week key (YYYY-Www)');
  }
  return value;
}

function validRouteDate(value) {
  if (!isValidDateString(value)) {
    throw httpError(400, 'Invalid calendar date (YYYY-MM-DD)');
  }
  return value;
}

function requireScheduleAdmin(req, res, next) {
  return requireAdmin(req, res, next);
}

mat.get('/api/schedule', requireScheduleAdmin, (req, res) => {
  res.json(store.schedule);
});

mat.put('/api/schedule/weekday/:wd', requireAdmin, async (req, res) => {
  const wd = validWeekday(req.params.wd);
  const ids = validatedDishIds(req.body);
  await mutateStore(() => {
    store.schedule.weekdays[wd] = ids;
  });
  res.json({ veckodag: VECKODAGAR[Number(wd)], dishIds: ids });
});

mat.put('/api/schedule/week/:key/:wd', requireAdmin, async (req, res) => {
  const key = validWeekKey(req.params.key);
  const wd = validWeekday(req.params.wd);
  const ids = validatedDishIds(req.body);
  await mutateStore(() => {
    store.schedule.weeks[key] ??= {};
    store.schedule.weeks[key][wd] = ids;
  });
  res.json({
    vecka: key,
    veckodag: VECKODAGAR[Number(wd)],
    dishIds: ids
  });
});

mat.put('/api/schedule/week/:key', requireAdmin, async (req, res) => {
  const key = validWeekKey(req.params.key);
  if (!req.body || typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      !req.body.days ||
      typeof req.body.days !== 'object' ||
      Array.isArray(req.body.days)) {
    throw httpError(400, 'days must be an object');
  }
  if (Object.keys(req.body.days).length > 7) {
    throw httpError(400, 'At most seven weekdays are allowed');
  }
  const days = {};
  for (const [wd, value] of Object.entries(req.body.days)) {
    validWeekday(wd);
    days[wd] = validatedDishIds({ dishIds: value });
  }
  await mutateStore(() => {
    store.schedule.weeks[key] = days;
  });
  res.json({ vecka: key, days });
});

mat.delete('/api/schedule/week/:key', requireAdmin, async (req, res) => {
  const key = validWeekKey(req.params.key);
  await mutateStore(() => {
    delete store.schedule.weeks[key];
  });
  res.json({ cleared: key });
});

mat.put('/api/schedule/override/:date', requireAdmin, async (req, res) => {
  const date = validRouteDate(req.params.date);
  const ids = validatedDishIds(req.body);
  await mutateStore(() => {
    store.schedule.overrides[date] = ids;
  });
  res.json({ date, dishIds: ids });
});

mat.delete('/api/schedule/override/:date', requireAdmin, async (req, res) => {
  const date = validRouteDate(req.params.date);
  await mutateStore(() => {
    delete store.schedule.overrides[date];
  });
  res.json({ cleared: date });
});

/* ---------------- display settings ---------------- */

mat.put('/api/display', requireAdmin, async (req, res) => {
  const settings = validateDisplay(req.body);
  await mutateStore(() => {
    store.display = { ...store.display, ...settings };
  });
  res.json(store.display);
});

/* ---------------- image uploads ---------------- */

/*
 * Accepts JSON:
 *   { "base64": "..." }
 *
 * The filename extension is checked against the actual decoded format.
 * The image is decoded and re-encoded, stripping embedded metadata.
 */
mat.post(
  '/api/images/:name',
  requireAdmin,
  imageLimiter,
  express.json({ limit: '6mb' }),
  async (req, res) => {
    const requestedName = req.params.name;
    if (!/^[a-zA-Z0-9_-]{1,100}\.(jpe?g|png|webp)$/i.test(requestedName)) {
      throw httpError(400, 'Invalid image filename');
    }
    if (!req.body || typeof req.body.base64 !== 'string') {
      throw httpError(400, 'base64 must be a string');
    }

    const encoded = req.body.base64;
    if (
      encoded.length === 0 ||
      encoded.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 16 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    ) {
      throw httpError(400, 'Invalid or oversized base64 image');
    }

    const buffer = Buffer.from(encoded, 'base64');
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
      throw httpError(400, 'Image must be between 1 byte and 4 MB');
    }

    const extension = path.extname(requestedName).slice(1).toLowerCase();
    const expectedFormat = extension === 'jpg' || extension === 'jpeg'
      ? 'jpeg'
      : extension;

    let image;
    let metadata;
    try {
      image = sharp(buffer, {
        limitInputPixels: MAX_IMAGE_PIXELS,
        animated: false
      });
      metadata = await image.metadata();
    } catch {
      throw httpError(400, 'Invalid or unsupported image');
    }

    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > MAX_IMAGE_DIMENSION ||
      metadata.height > MAX_IMAGE_DIMENSION ||
      metadata.width * metadata.height > MAX_IMAGE_PIXELS ||
      metadata.format !== expectedFormat
    ) {
      throw httpError(400, 'Image format or dimensions are not allowed');
    }

    let output;
    try {
      const pipeline = sharp(buffer, {
        limitInputPixels: MAX_IMAGE_PIXELS,
        animated: false
      }).rotate();
      if (expectedFormat === 'jpeg') {
        output = await pipeline.jpeg({ quality: 85 }).toBuffer();
      } else if (expectedFormat === 'png') {
        output = await pipeline.png().toBuffer();
      } else {
        output = await pipeline.webp({ quality: 85 }).toBuffer();
      }
    } catch {
      throw httpError(400, 'Image could not be decoded');
    }

    const finalName = requestedName.toLowerCase();
    const destination = path.join(IMAGES_DIR, finalName);

    /*
     * wx prevents silently overwriting an existing file.
     * The normalized filename is restricted to a safe character set.
     */
    const tmp = path.join(
      IMAGES_DIR,
      `.upload-${crypto.randomBytes(12).toString('hex')}.tmp`
    );
    try {
      fs.writeFileSync(tmp, output, { flag: 'wx', mode: 0o640 });
      if (fs.existsSync(destination)) {
        throw httpError(409, 'Image already exists');
      }
      fs.renameSync(tmp, destination);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch {}
      if (err.status) throw err;
      throw err;
    }

    res.status(201).json({
      file: publicImageUrl(finalName)
    });
  }
);

/* ---------------- admin token verification ---------------- */

mat.post('/api/admin/verify', requireAdmin, (req, res) => {
  res.json({ ok: true });
});

/* ---------------- 404 and error handling ---------------- */

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err.status) &&
    err.status >= 400 && err.status <= 599
    ? err.status
    : 500;
  if (status >= 500) {
    console.error('[meny] Request failed:', err.message);
  }
  res.status(status).json({
    error: status === 500
      ? 'Internal server error'
      : status === 413
        ? 'Request body too large'
        : err.message
  });
});

/* ---------------- start ---------------- */

ensureDirectories();
loadStore();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Matsal-menyn listening on port ${PORT}`);
  console.log(`Display: http://localhost:${PORT}${BASE_PATH}/`);
  console.log(`Admin:   http://localhost:${PORT}${BASE_PATH}/admin`);
});

function shutdown(signal) {
  console.log(`[meny] ${signal}: shutting down`);
  server.close(err => {
    if (err) {
      console.error('[meny] Shutdown failed:', err.message);
      process.exitCode = 1;
    }
    process.exit();
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
