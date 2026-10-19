'use strict';

/* =========================================================
   Matsal-menyn – webbbaserad lunchmeny för skola
   ---------------------------------------------------------
   <bas>/         -> kioskvisning i fullskärm (endast dagens måltider)
   <bas>/admin    -> backend-gränssnitt (skyddas med x-admin-token)
   Bas-sökvägen (<bas>) styrs med miljövariabeln BASE_PATH, standard /meny.
   BASE_PATH="" kör allt i roten: http://localhost:3000/ och /admin.
   Backend äger: rätter, veckoschema och datum-undantag.
   Frontend ser aldrig schemat – bara den färdiga dagens meny.
   ========================================================= */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');  // projektroten (server.js ligger i src/)
const DATA_FILE = path.join(ROOT, 'data', 'meals.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const IMAGES_DIR = path.join(ROOT, 'images');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-token-change-me';
const MAX_MEALS_PER_DAY = 3;

// Bas-sökväg: "/meny" (standard), t.ex. "/mat", eller "" för att köra i roten
const RAW_BASE = (process.env.BASE_PATH ?? '/meny').trim().replace(/\/+$/, '');
const BASE_PATH = RAW_BASE && !RAW_BASE.startsWith('/') ? '/' + RAW_BASE : RAW_BASE;

const VECKODAGAR = [null, 'Måndag', 'Tisdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lördag', 'Söndag'];

const ALLERGEN_ETIKETTER = {
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
  blodskaldjur: 'Blötdjur',
};

/* ---------------- datalager ---------------- */

let store = null;

function loadStore() {
  store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  store.dishes ||= [];
  store.schedule ||= {};
  store.schedule.weekdays ||= {};
  store.schedule.overrides ||= {};
  store.schedule.weeks ||= {};
  store.display ||= {};
}

function saveStore() {                       // atomisk skrivning
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function dishById(id) { return store.dishes.find(d => d.id === id); }

function todayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

function isoVeckodag(dateStr) {              // 1 = måndag ... 7 = söndag
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return ((dt.getDay() + 6) % 7) + 1;
}

function isoVeckaNyckel(dateStr) {           // "ÅÅÅÅ-Wvv" enligt ISO-8601
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dag = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dag);
  const arStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const vecka = Math.ceil(((dt - arStart) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(vecka).padStart(2, '0')}`;
}

function veckorIAret(ar) {                   // 52 eller 53 enligt ISO-8601
  const jan1 = new Date(Date.UTC(ar, 0, 1));
  const skott = (ar % 4 === 0 && ar % 100 !== 0) || ar % 400 === 0;
  return (jan1.getUTCDay() === 4 || (skott && jan1.getUTCDay() === 3)) ? 53 : 52;
}

function veckonyckel(key) {                  // validera "ÅÅÅÅ-Wvv" -> { ar, vecka } | null
  const m = /^(\d{4})-W(\d{2})$/.exec(String(key));
  if (!m) return null;
  const ar = +m[1], vecka = +m[2];
  return vecka >= 1 && vecka <= veckorIAret(ar) ? { ar, vecka } : null;
}

/* Den enda funktionen frontend är beroende av.
   Uppslagning per dag: datum-undantag > veckans planering > standardveckoschema. */
function menuFor(dateStr) {
  const wd = isoVeckodag(dateStr);
  const veckaKey = isoVeckaNyckel(dateStr);
  const override = store.schedule.overrides[dateStr];
  const veckaDag = (store.schedule.weeks[veckaKey] || {})[String(wd)];

  let ids, kalla;
  if (override !== undefined) { ids = override; kalla = 'override'; }
  else if (veckaDag !== undefined) { ids = veckaDag; kalla = 'vecka'; }
  else { ids = store.schedule.weekdays[String(wd)] || []; kalla = 'veckodag'; }

  const dishes = ids.map(id => {
    const dish = dishById(id);
    if (!dish) console.warn(`[meny] okänt rätt-id "${id}" på ${dateStr}`);
    return dish;
  }).filter(Boolean).slice(0, MAX_MEALS_PER_DAY);

  return {
    date: dateStr,
    weekday: wd,
    weekdayName: VECKODAGAR[wd],
    week: veckaKey,
    source: kalla,
    dishes,
    display: store.display,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeDish(body) {
  if (!body || !body.id || !body.name) return null;
  return {
    id: String(body.id).toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
    name: String(body.name),
    description: String(body.description || ''),
    ingredients: String(body.ingredients || ''),
    allergens: Array.isArray(body.allergens) ? body.allergens.map(String) : [],
    tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
    price: body.price ?? null,
    image: String(body.image || ''),
    origin: String(body.origin || ''),
  };
}

/* ---------------- autentisering (admin) ---------------- */

function isAdmin(req) {
  const a = Buffer.from(String(req.headers['x-admin-token'] || ''));
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------- app ---------------- */

const app = express();
app.use(express.json({ limit: '2mb' }));

function page(name) {
  return (req, res) => {
    // always validate HTML in the browser: prevents stale scripts in kiosk mode
    res.set('Cache-Control', 'no-cache');
    res.type('html').sendFile(path.join(PUBLIC_DIR, name));
  };
}
/* Allt monteras under BASE_PATH: visning, admin, api och bilder */
const mat = express.Router();
mat.get('/', page('display.html'));
mat.get('/display', page('display.html'));
mat.get('/admin', page('admin.html'));
mat.use('/images', express.static(IMAGES_DIR, { maxAge: '1h' }));

app.use(BASE_PATH || '/', mat);

/* påminn gamla sökvägar vidare när en bas-sökväg är satt */
if (BASE_PATH) {
  app.get('/', (req, res) => res.redirect(BASE_PATH));
  app.get('/admin', (req, res) => res.redirect(BASE_PATH + '/admin'));
}

/* --- publikt API (frontend använder bara dessa) --- */

mat.get('/api/menu/today', (req, res) => res.json(menuFor(todayStr())));
mat.get('/api/menu/:date', (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date))
    return res.status(400).json({ error: 'datum måste vara ÅÅÅÅ-MM-DD' });
  res.json(menuFor(req.params.date));
});
mat.get('/api/allergen-labels', (req, res) => res.json(ALLERGEN_ETIKETTER));

/* --- rätter --- */

mat.get('/api/dishes', (req, res) => res.json(store.dishes));

mat.post('/api/dishes', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Saknar eller fel x-admin-token' });
  const dish = normalizeDish(req.body);
  if (!dish) return res.status(400).json({ error: 'id och name är obligatoriska' });
  if (dishById(dish.id)) return res.status(409).json({ error: `rätten ${dish.id} finns redan – använd PUT` });
  store.dishes.push(dish);
  saveStore();
  res.status(201).json(dish);
});

mat.put('/api/dishes/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Saknar eller fel x-admin-token' });
  const dish = normalizeDish({ ...req.body, id: req.params.id });
  if (!dish) return res.status(400).json({ error: 'name är obligatoriskt' });
  const i = store.dishes.findIndex(d => d.id === dish.id);
  if (i === -1) return res.status(404).json({ error: 'okänt rätt-id' });
  store.dishes[i] = dish;
  saveStore();
  res.json(dish);
});

mat.delete('/api/dishes/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Saknar eller fel x-admin-token' });
  const before = store.dishes.length;
  store.dishes = store.dishes.filter(d => d.id !== req.params.id);
  if (store.dishes.length === before) return res.status(404).json({ error: 'okänt rätt-id' });
  saveStore();
  res.json({ deleted: req.params.id });
});

/* --- schema (veckodagar + datum-undantag) --- */

mat.get('/api/schedule', (req, res) => res.json(store.schedule));

mat.put('/api/schedule/weekday/:wd', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Saknar eller fel x-admin-token' });
  const wd = req.params.wd;
  if (!/^[1-7]$/.test(wd)) return res.status(400).json({ error: 'wd måste vara 1..7 (1 = måndag)' });
  const ids = (req.body?.dishIds || []).map(String).filter(Boolean).slice(0, MAX_MEALS_PER_DAY);
  const unknown = ids.filter(id => !dishById(id));
  if (unknown.length) return res.status(400).json({ error: `okända rätt-id:n: ${unknown.join(', ')}` });
  store.schedule.weekdays[wd] = ids;
  saveStore();
  res.json({ veckodag: VECKODAGAR[+wd], dishIds: ids });
});

/* --- per-vecka-planering: nyckel "ÅÅÅÅ-Wvv" (ISO-vecka) --- */

mat.put('/api/schedule/week/:key/:wd', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Saknar eller fel x-admin-token' });
  if (!veckonyckel(req.params.key)) return res.status(400).json({ error: 'ogiltig veckonyckel (format ÅÅÅÅ-Wvv)' });
  const wd = req.params.wd;
  if (!/^[1-7]$/.test(wd)) return res.status(400).json({ error: 'wd måste vara 1..7 (1 = måndag)' });
  const ids = (req.body?.dishIds || []).map(String).filter(Boolean).slice(0, MAX_MEALS_PER_DAY);
  const unknown = ids.filter(id => !dishById(id));
  if (unknown.length) return res.status(400).json({ error: `okända rätt-id:n: ${unknown.join(', ')}` });
  store.schedule.weeks[req.params.key] ||= {};
  store.schedule.weeks[req.params.key][wd] = ids;
  saveStore();
  res.json({ vecka: req.params.key, veckodag: VECKODAGAR[+wd], dishIds: ids });
});

mat.put('/api/schedule/week/:key', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Saknar eller fel x-admin-token' });
  if (!veckonyckel(req.params.key)) return res.status(400).json({ error: 'ogiltig veckonyckel (format ÅÅÅÅ-Wvv)' });
  const städa = {};
  for (const [wd, ids] of Object.entries(req.body?.days || {})) {
    if (!/^[1-7]$/.test(wd)) return res.status(400).json({ error: `ogiltig veckodag: ${wd}` });
    städa[wd] = (ids || []).map(String).filter(Boolean).slice(0, MAX_MEALS_PER_DAY);
    const unknown = städa[wd].filter(id => !dishById(id));
    if (unknown.length) return res.status(400).json({ error: `okända rätt-id:n: ${unknown.join(', ')}` });
  }
  store.schedule.weeks[req.params.key] = städa;
  saveStore();
  res.json({ vecka: req.params.key, days: städa });
});

mat.delete('/api/schedule/week/:key', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Saknar eller fel x-admin-token' });
  delete store.schedule.weeks[req.params.key];
  saveStore();
  res.json({ cleared: req.params.key });
});

mat.put('/api/schedule/override/:date', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Saknar eller fel x-admin-token' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return res.status(400).json({ error: 'ogiltigt datum' });
  const ids = (req.body?.dishIds || []).map(String).filter(Boolean).slice(0, MAX_MEALS_PER_DAY);
  const unknown = ids.filter(id => !dishById(id));
  if (unknown.length) return res.status(400).json({ error: `okända rätt-id:n: ${unknown.join(', ')}` });
  store.schedule.overrides[req.params.date] = ids;   // [] = "köket stängt"
  saveStore();
  res.json({ date: req.params.date, dishIds: ids });
});

mat.delete('/api/schedule/override/:date', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Saknar eller fel x-admin-token' });
  delete store.schedule.overrides[req.params.date];
  saveStore();
  res.json({ cleared: req.params.date });
});

/* --- visningsinställningar --- */

mat.put('/api/display', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Saknar eller fel x-admin-token' });
  store.display = { ...store.display, ...req.body };
  saveStore();
  res.json(store.display);
});

/* --- valfri bilduppladdning (base64 i JSON) --- */

mat.post('/api/images/:name', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Saknar eller fel x-admin-token' });
  const name = req.params.name;
  if (!/^[a-z0-9._-]+\.(jpe?g|png|webp)$/i.test(name)) return res.status(400).json({ error: 'ogiltigt filnamn' });
  const buf = Buffer.from(String(req.body?.base64 || ''), 'base64');
  if (!buf.length || buf.length > 4_000_000) return res.status(400).json({ error: 'tom eller för stor (>4 MB)' });
  fs.writeFileSync(path.join(IMAGES_DIR, name), buf);
  res.json({ file: `/images/${name}` });
});

/* --- tokenkontroll för inloggning i admin-UI --- */

mat.post('/api/admin/verify', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Fel token' });
  res.json({ ok: true });
});

/* ---------------- starta ---------------- */

loadStore();
app.listen(PORT, () => {
  console.log(`Matsal-menyn körs på http://localhost:${PORT}`);
  const bas = BASE_PATH || '';
  console.log(`  visning: http://localhost:${PORT}${bas}/   admin: http://localhost:${PORT}${bas}/admin`);
});
