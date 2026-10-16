# Matsal-menyn

Webbbaserad lunchmeny för skolmatsal. Backend (Node.js/Express) styr rätter, schema och
veckoplanering; frontend är en fullskärmssida för en webbläsare/TV i matsalen som **endast**
visar dagens måltider (max 3 per dag).

- **Visning** (matsalsskärm): `/meny` – dagens måltider med bild, innehåll, allergener och pris
- **Backend** (kökspersonal): `/meny/admin` – redigera rätter, veckoschema, veckoplanering och datum-undantag

## Kom igång med Docker (rekommenderas)

```bash
cp .env.example .env      # öppna .env och byt ADMIN_TOKEN!
docker compose up -d --build
```

- Visning: http://localhost:3000/meny
- Admin: http://localhost:3000/meny/admin (ange din token från `.env`)

All data (rätter, schema, veckoplanering, bilder) lagras i Docker-volymer och överlever
omstart och uppgraderingar. Loggar: `docker compose logs -f`.

## Kom igång utan Docker

```bash
npm install
ADMIN_TOKEN='byt-mot-något-hemligt' npm start
```

Servern lyssnar på port 3000 (ändra med `PORT`). Data sparas i `data/meals.json`.

### Bas-sökväg

Allt serveras som standard under `/meny`. Vill du ha en annan sökväg – eller allt i roten –
sätt miljövariabeln `BASE_PATH` (`/mat`, eller tom för `http://localhost:3000/`).
Se [docs/ANVANDNING.md](docs/ANVANDNING.md#bas-sökväg-base_path).

## Dokumentation

| Dokument | Innehåll |
|---|---|
| [docs/ANVANDNING.md](docs/ANVANDNING.md) | Så använder du systemet: skärmen, admin-UI, veckoplanering, kioskläge, uppgradering |
| [docs/API.md](docs/API.md) | Fullständig API-referens med exempel (curl) |

## Hur det hänger ihop

```
matsalsskärmen (browser/TV, kioskläge)
      │  GET /meny  +  GET /meny/api/menu/today  (var 30:e sekund)
      ▼
Express-server  ────  data/meals.json  (rätter, veckoschema, veckoplanering, undantag)
      ▲                          ▲
      │  /meny/admin              │  skrivs via API:et (atomiskt, hela filen)
admin-webbläsaren ──────────────┘
```

Menyn slås upp per dag i tre nivåer – första träffen vinner:

1. **Datum-undantag** – enstaka avvikelser, t.ex. julafton (`[]` = köket stängt)
2. **Veckoplanering** – egen planering för en specifik ISO-vecka, t.ex. `2026-W42` (52–53 veckor/år)
3. **Standardveckoschema** – samma rutin varje måndag, tisdag, …

## Funktioner

- Fullskärmssida för matsalsskärmen: auto-uppdatering var 30:e sekund, hanterar tappad anslutning, landskap och porträtt
- Rättredigerare i webbgränssnittet: lägg till, redigera, ta bort, ladda upp bilder (JPG/PNG/WebP)
- Veckoplanering för alla årets 52–53 veckor med årsoversikt och kopieringsknappar
- Svenska allergenetiketter (EU:s 14 allergener), priser, ursprungsmärkning
- Max 3 måltider per dag – tvingas på serversidan
- Admin skyddas med token ( jämförelse med konstant tid), kör som icke-root i Docker
- Ingen databas – allting i en JSON-fil som är enkel att backa upp (`scripts/backup.sh`)
- Körklart backupskript + schema för daglig cron-backup och bortkopiering (3-2-1)

## Säkerhet i produktion

- Byt `ADMIN_TOKEN` till något långt och slumpat (`openssl rand -hex 32`)
- Kör bara HTTP inom skolans nätverk – eller lägg en reverse proxy (nginx/Caddy) framför med HTTPS
- Vill du sitta bakom HTTPS redan i admin: se [docs/ANVANDNING.md](docs/ANVANDNING.md#reverse-proxy-med-https-valfritt)

## Licens

[MIT](LICENSE)
