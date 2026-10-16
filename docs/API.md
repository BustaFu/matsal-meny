# API-referens

Bas-URL: `http://<server>:3000/mat` (styrs av `BASE_PATH` – t.ex. `/mat` eller tom för roten; uppdatera bas-URL:en i exemplen nedan)

- Publika endpoints kräver ingen autentisering – det är de frontend (matsalsskärmen) använder.
- Alla skrivande endpoints kräver headern `x-admin-token` med värdet av `ADMIN_TOKEN`.
- Alla begäran och svar är JSON. Fel returneras som `{"error": "förklaring"}`.
- Max 3 måltider per dag tvingas alltid på serversidan (`MAX_MEALS_PER_DAY`).

```
Authorization-header:  x-admin-token: <din token>
```

---

## Publika endpoints

### `GET /meny/api/menu/today`

Dagens meny. Datumavgörande är serverns tidszon (`TZ`).

**Svar 200:**

```json
{
  "date": "2026-10-16",
  "weekday": 5,
  "weekdayName": "Fredag",
  "week": "2026-W42",
  "source": "veckodag",
  "dishes": [
    {
      "id": "havregrot",
      "name": "Havregrynsgröt",
      "description": "Krämig havregrynsgröt med varm hallonsås.",
      "ingredients": "Havregryn, vatten, mjölk, hallon, potatismjöl",
      "allergens": ["mjolk", "gluten"],
      "tags": ["vegetarisk", "barnfavorit"],
      "price": 35,
      "image": "grot.jpg",
      "origin": "Havre från kvarnen i byn"
    }
  ],
  "display": {
    "subtitle": "Alla måltider serveras med bröd, salladsbuffé, vatten och mjölk.",
    "closedMessage": "Köket är stängt i dag – glöm inte din matsäck",
    "refreshSeconds": 30
  },
  "updatedAt": "2026-10-16T09:12:44.101Z"
}
```

`source` visar var dagens meny hämtades: `override` (datum-undantag), `vecka` (veckoplanering)
eller `veckodag` (standardveckoschema). `dishes` är `[]` när köket är stängt.

```bash
curl http://localhost:3000/meny/api/menu/today
```

### `GET /meny/api/menu/:datum`

Samma svar för valt datum (`ÅÅÅÅ-MM-DD`). Bra för förhandsvisning och framtidsplanering.

```bash
curl http://localhost:3000/meny/api/menu/2026-12-24
```

**Fel:** `400` om datumformatet är ogiltigt.

### `GET /meny/api/allergen-labels`

Svenska etiketter för allergenkoderna (EU:s 14 allergener).

```bash
curl http://localhost:3000/meny/api/allergen-labels
```

```json
{ "gluten": "Gluten", "mjolk": "Mjölk", "fisk": "Fisk", "...": "..." }
```

---

## Rätter

### `GET /meny/api/dishes`

Alla rätter som array (samma objektform som i menysvaret ovan). *Publik.*

### `POST /meny/api/dishes` 🔒

Skapa rätt. `id` och `name` är obligatoriska; övriga fält är valfria.

```bash
curl -X POST http://localhost:3000/meny/api/dishes \
  -H 'content-type: application/json' \
  -H 'x-admin-token: $ADMIN_TOKEN' \
  -d '{
    "id": "kotbullar",
    "name": "Köttbullar med potatismos",
    "description": "Med lingonsylt och gräddsås.",
    "ingredients": "Köttfärs, lök, potatis, grädde",
    "allergens": ["gluten", "mjolk"],
    "tags": ["svensk klassiker"],
    "price": 55,
    "image": "kotbullar.jpg",
    "origin": "Kött från Sverige"
  }'
```

**Svar:** `201` med rätt-objektet. `id` normaliseras till gemener, siffror och bindestreck.
**Fel:** `400` (id/name saknas), `401` (fel token), `409` (id finns redan – använd PUT).

### `PUT /meny/api/dishes/:id` 🔒

Uppdatera hela rätten (samma fält som POST). `name` är obligatoriskt.

```bash
curl -X PUT http://localhost:3000/meny/api/dishes/kotbullar \
  -H 'content-type: application/json' \
  -H 'x-admin-token: $ADMIN_TOKEN' \
  -d '{ "name": "Köttbullar med ris", "price": 52 }'
```

**Svar:** `200` med uppdaterat objekt. **Fel:** `400`, `401`, `404` (okänt id).

### `DELETE /meny/api/dishes/:id` 🔒

Ta bort rätten. Rätter som finns kvar i scheman visas som varning i admin-UI men ignoreras
av menyuppslaget.

**Svar:** `200` med `{"deleted": "kotbullar"}`. **Fel:** `401`, `404`.

---

## Schema

### `GET /meny/api/schedule`

Hela schemat: standardveckodagar, veckoplanering, undantag.

```json
{
  "weekdays": { "1": ["havregrot", "pasta-bolognese"], "2": [], "...": [] },
  "weeks":   { "2026-W42": { "1": ["sillvisa"] } },
  "overrides": { "2026-12-24": [] }
}
```

Veckodagar är `1 = måndag … 7 = söndag`. Veckonycklar är ISO-8601 (`ÅÅÅÅ-Wvv`).

### `PUT /meny/api/schedule/weekday/:wd` 🔒

Sätt standardveckoschemat för en veckodag (`1–7`).

```bash
curl -X PUT http://localhost:3000/meny/api/schedule/weekday/4 \
  -H 'content-type: application/json' \
  -H 'x-admin-token: $ADMIN_TOKEN' \
  -d '{ "dishIds": ["pasta-bolognese", "risbowl"] }'
```

**Svar:** `200` med `{"veckodag": "Torsdag", "dishIds": [...]}`.
**Fel:** `400` (ogiltig dag eller okänt rätt-id), `401`.

### `PUT /meny/api/schedule/week/:key` 🔒

Planera en hel vecka på en gång (`key` = `ÅÅÅÅ-Wvv`, t.ex. `2026-W42`). Nycklar utanför
årets 52–53 veckor avvisas.

```bash
curl -X PUT http://localhost:3000/meny/api/schedule/week/2026-W42 \
  -H 'content-type: application/json' \
  -H 'x-admin-token: $ADMIN_TOKEN' \
  -d '{ "days": { "1": ["fisksoppa"], "3": ["risbowl", "veggie-wraps"] } }'
```

**Svar:** `200` med `{"vecka": "2026-W42", "days": {...}}` (utan angivna dagar blir tomma).

### `PUT /meny/api/schedule/week/:key/:wd` 🔒

Ändra en enda dag i en planerad vecka.

```bash
curl -X PUT http://localhost:3000/meny/api/schedule/week/2026-W42/5 \
  -H 'content-type: application/json' \
  -H 'x-admin-token: $ADMIN_TOKEN' \
  -d '{ "dishIds": ["havregrot", "fisksoppa"] }'
```

**Fel:** `400` (ogiltig vecka, dag eller rätt-id), `401`.

### `DELETE /meny/api/schedule/week/:key` 🔒

Rensa veckans planering – standardveckoschemat gäller igen.

**Svar:** `200` med `{"cleared": "2026-W42"}`.

### `PUT /meny/api/schedule/override/:datum` 🔒

Lägg till/ändra undantag för ett datum (`ÅÅÅÅ-MM-DD`). **Tom lista = köket stängt.**
Undantag slagr både veckoplanering och standardveckoschema.

```bash
curl -X PUT http://localhost:3000/meny/api/schedule/override/2026-12-24 \
  -H 'content-type: application/json' \
  -H 'x-admin-token: $ADMIN_TOKEN' \
  -d '{ "dishIds": [] }'
```

### `DELETE /meny/api/schedule/override/:datum` 🔒

Ta bort undantaget så att schemat gäller igen.

**Svar:** `200` med `{"cleared": "2026-12-24"}`.

---

## Visning och bilder

### `PUT /meny/api/display` 🔒

Ändra visningstexter på skärmen. Fält som utelämnas behålls.

```bash
curl -X PUT http://localhost:3000/meny/api/display \
  -H 'content-type: application/json' \
  -H 'x-admin-token: $ADMIN_TOKEN' \
  -d '{ "subtitle": "Bröd, sallad och dryck ingår.", "closedMessage": "Stängt i dag!" }'
```

| Fält | Verkan |
|---|---|
| `title` | Valfri liten rubrik ovanför datumet |
| `subtitle` | Underrubrik i nederkanten |
| `closedMessage` | Text när `dishes` är tom |
| `refreshSeconds` | Uppdateringsintervall på skärmen |

### `POST /meny/api/images/:namn` 🔒

Ladda upp en bild (base64 i JSON). Filnamnet måste sluta på `.jpg`, `.jpeg`, `.png` eller
`.webp` och få innehålla `a–z 0–9 . _ -`. Max 4 MB.

```bash
curl -X POST http://localhost:3000/meny/api/images/kotbullar.jpg \
  -H 'content-type: application/json' \
  -H 'x-admin-token: $ADMIN_TOKEN' \
  -d "{ \"base64\": \"$(base64 -w0 kotbullar.jpg)\" }"
```

**Svar:** `200` med `{"file": "/meny/images/kotbullar.jpg"}` – lägg sedan det filnamnet som
`image`-fält på rätten. Bilder serveras från `GET /meny/images/<namn>`.

### `POST /meny/api/admin/verify` 🔒

Kontrollera att token är giltig (används av inloggningen i admin-UI).

**Svar:** `200` med `{"ok": true}` eller `401`.

---

## Felkoder i korthet

| Kod | Betydelse |
|---|---|
| `400` | Ogiltigt datum, vecka, dag eller okänt rätt-id |
| `401` | Saknar eller fel `x-admin-token` |
| `404` | Rätten/objektet finns inte |
| `409` | Rätten med samma id finns redan |
