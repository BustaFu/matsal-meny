# Användning

Så här jobbar du med matsal-menyn i vardagen – från första igångsättning till flytt på ny server.

## 1. Igångsättning

### Docker (rekommenderas)

```bash
git clone https://github.com/ditt-konto/matsal-menu.git
cd matsal-menu
cp .env.example .env
```

Öppna `.env` och sätt en riktig token:

```
ADMIN_TOKEN=<kör: openssl rand -hex 32>
```

Starta:

```bash
docker compose up -d --build
```

Klart. Visning: http://localhost:3000/meny · Admin: http://localhost:3000/meny/admin

### Utan Docker

```bash
npm install
ADMIN_TOKEN='din-token' npm start
```

### Bas-sökväg (BASE_PATH)

Allt serveras som standard under `/meny`. Vill du ha en annan sökväg – eller allt i roten –
sätt miljövariabeln `BASE_PATH` och starta om:

| BASE_PATH | Visning | Admin |
|---|---|---|
| `/meny` (standard) | `http://localhost:3000/meny` | `http://localhost:3000/meny/admin` |
| `/mat` | `http://localhost:3000/mat` | `http://localhost:3000/mat/admin` |
| tom (`BASE_PATH=`) | `http://localhost:3000/` | `http://localhost:3000/admin` |

I docker-compose: lägg t.ex. `BASE_PATH=/mat` i `.env` och kör `docker compose up -d`.
Med bas-sökväg satt skickas `/` och `/admin` automatiskt vidare till rätt plats. Sidorna
anpassar sig själva till sökvägen – peka bara skärmen och admin på den nya adressen.

## 2. Matsalsskärmen

Pekaren på skärmen i matsalen mot:

```
http://<server-ip>:3000/meny
```

Starta webbläsaren i kioskläge så att adressfält och menyer försvinner:

```bash
chromium --kiosk --no-first-run --disable-infobars http://<server-ip>:3000/meny
```

- Sidan är byggd för fullskärm (100 % av skärmen, ingen scroll) och anpassar sig till både
  landskap och porträtt.
- Den uppdaterar sig själv var 30:e sekund – ändrar köket menyn syns det automatiskt.
- Bryts anslutningen till servern visas "tappad anslutning" i hörnet men senaste menyn ligger kvar.
- Klockan uppe till höger uppdateras varje sekund.

## 3. Admin-gränssnittet

Gå till `/meny/admin` och logga in med din `ADMIN_TOKEN`.

### Rätter (första fliken)

- **+ Ny rätt** – öppnar rättredigeraren: namn, beskrivning, innehåll, pris, ursprung,
  taggar och allergenkryssrutor. Id genereras automatiskt från namnet.
- **Bild**: välj en fil (JPG/PNG/WebP, max 4 MB) så laddas den upp direkt med förhandsvisning.
- **Redigera / Ta bort** direkt i listan. Tar du bort en rätt som ligger i ett schema varnas du.

### Veckoschema (andra fliken)

Standardrutinen måndag–söndag, tre måltidsrutor per dag. Spara sker automatiskt när du
ändrar en rullgardinslista. Detta schema används varje vecka som *inte* har egen planering.

### Veckoplanering (tredje fliken)

Planera **alla årets 52–53 veckor** individuellt (ISO-veckor, "vecka 42"-stil):

- Bläddra med ◀ ▶ eller klicka direkt i årsoversikten (grön knapp = veckan har egen planering).
- Tre rullgardinslistor per dag – sparas direkt.
- **Kopiera standardschemat till veckan** – bra när ett nytt läsår börjar.
- **Kopiera föregående vecka** – snabbt att rita liknande veckor.
- **Rensa veckans planering** – standardschemat gäller igen.

### Datum-undantag (fjärde fliken)

Enstaka dagar som avviker: lov, helgdagar, studiedagar. Lägg till ett datum och fyll dagens
rätter – eller lämna tomma så visas "Köket är stängt" på skärmen. Ta bort krysset så gäller
veckoschemat igen.

**Prioritet:** undantag → veckans planering → standardveckoschema.

## 4. Vad som visas på skärmen

Varje måltid visar: bild, namn, beskrivning, innehållsförteckning, allergenmarkeringar
(svenska etiketter enligt EU:s 14 allergener), taggar (t.ex. "vegansk"), pris och ursprung.
Rubriken är dag och datum ("Fredag 16 oktober"), klockan sitter uppe till höger, och
underrubriken (t.ex. "Alla måltider serveras med bröd och sallad") styrs via `PUT /meny/api/display`.

## 5. Underhåll

### Säkerhetskopiering (rekommenderad uppsättning)

All data ligger i två ställen: menydatan i `data/meals.json` och bilderna i `images/`.
Menyskrivningar är atomiska (tmp-fil + byte), så backup kan och bör tas **medan systemet
är i drift** – containern behöver aldrig stoppas.

Repet: `scripts/backup.sh` gör allt detta åt dig (Docker och lokalt):

```bash
chmod +x scripts/backup.sh
./scripts/backup.sh                  # Docker-installation
./scripts/backup.sh --lokalt         # installation utan Docker
```

Skriptet packar `data/ + images/` till `/var/backups/matsal-menu/matsal-ÅÅÅÅ-MM-DD-TTMM.tar.gz`,
verifierar att arkivet innehåller menydatan och städar bort backups äldre än 14 dagar
(`BACKUP_KATALOG` och `BEHALL` kan styras via miljövariabler).

#### 1. Schemalägg daglig backup med cron

```bash
crontab -e
```

Lägg till raden (varje dag 23:30, logg till /var/log):

```
30 23 * * * cd /opt/matsal-menu && ./scripts/backup.sh >> /var/log/matsal-backup.log 2>&1
```

#### 2. Kopiera bort backuperna från servern (3-2-1-regeln)

En backup på samma maskin räddar dig vid felsökta ändringar – men inte om disken går sönder.
Skicka därför bort kopian till en annan maskin, t.ex. med rsync via cron på en annan server
eller NAS:

```bash
rsync -a --delete /var/backups/matsal-menu/ backup@nas:/backup/matsal-menu/
```

Alternativ till moln (S3-kompatibel bucket med rclone):

```bash
rclone copy /var/backups/matsal-menu/ moln:matsal-backups/ --max-age 30d
```

#### 3. Testa återställningen då och då

En backup man aldrig provat att återställa är ingen backup. Snabbtest:

```bash
# packa upp och kontrollera innehållet
tar tzf /var/backups/matsal-menu/matsal-ÅÅÅÅ-MM-DD-*.tar.gz | head
```

#### Återställa

```bash
# 1. packa upp backupen
mkdir /tmp/aterstall && tar xzf /var/backups/matsal-menu/matsal-ÅÅÅÅ-MM-DD-*.tar.gz -C /tmp/aterstall

# 2a. Docker: kopiera in i volymerna och starta om
docker compose cp /tmp/aterstall/data/meals.json matsal-menu:/app/data/meals.json
docker compose cp /tmp/aterstall/images/. matsal-menu:/app/images/
docker compose restart matsal-menu

# 2b. Utan Docker: kopiera tillbaka i projektkatalogen och starta om
cp /tmp/aterstall/data/meals.json data/meals.json
cp -r /tmp/aterstall/images/. images/
```

> **Tips:** Ta också en manuell backup innan större ändringar, t.ex. innan terminsschema
> planeras in i bulk: `./scripts/backup.sh` – tar fem sekunder och ger en snabb återgångspunkt.

### Uppgradera till ny version

```bash
git pull
docker compose up -d --build
```

Datan ligger i volymer och påverkas inte.

### Flytta till en ny server

1. Säkerhetskopiera `meals.json` (och `images/`).
2. Installera enligt steg 1 på den nya servern.
3. Kopiera tillbaka filerna (i Docker: `docker compose cp meals.json matsal-menu:/app/data/`).

### Reverse proxy med HTTPS (valfritt)

Menyn i matsalen behöver sällan HTTPS (ingen inmatning sker där), men admin gör det om den
används över nätet. Exempel med Caddy (automatisk Let's Encrypt):

```
matsal.skolan.se {
    reverse_proxy localhost:3000
}
```

eller nginx:

```nginx
location / {
    proxy_pass http://localhost:3000;
    proxy_set_header Host $host;
}
```

Låt sedan skärmen peka på proxyn. Glöm inte att sätta rätt `ADMIN_TOKEN`.

## 6. Felsökning

| Problem | Lösning |
|---|---|
| "Tappad anslutning" på skärmen | Servern svarar inte – kolla `docker compose logs -f` och att containern kört upp |
| Inga bilder visas | Bildfilerna måste finnas i `images/` (eller volymen `matsal-images`) med exakt namn som i rättens `image`-fält |
| Fel dag visas | Kolla tidszonen – sätt `TZ=Europe/Stockholm` i `.env` |
| "Fel token" i admin | Token står i `.env` (miljövariabeln `ADMIN_TOKEN`); starta om containern om du ändrat den |
| Menyn ändrades inte | Skärmen uppdaterar sig själv var 30:e sekund – vänta eller ladda om sidan |
