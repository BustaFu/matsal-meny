#!/usr/bin/env bash
# backup.sh – säkerhetskopierar matsal-menyndata (data/ + images/)
#
# Användning:
#   ./scripts/backup.sh            # Docker-installation (via docker compose i denna katalog)
#   ./scripts/backup.sh --lokalt   # installation utan Docker
#
# Miljövariabler:
#   BACKUP_KATALOG   vart backuperna hamnar (standard: /var/backups/matsal-meny)
#   BEHALL           hur många dagar som behålls (standard: 14)
#
# Kan köras medan systemet är i drift – menyskrivningarna är atomiska
# (tmp-fil + byte), så containern behöver aldrig stoppas.

set -euo pipefail

LOKALT=false
if [ "${1:-}" = "--lokalt" ]; then LOKALT=true; fi

KATALOG="${BACKUP_KATALOG:-/var/backups/matsal-meny}"
BEHALL="${BEHALL:-14}"
PROJEKT="$(cd "$(dirname "$0")/.." && pwd)"

STAMP="$(date +%F-%H%M)"
FIL="$KATALOG/matsal-$STAMP.tar.gz"

mkdir -p "$KATALOG"

if $LOKALT; then
  tar czf "$FIL" -C "$PROJEKT" data images
else
  docker compose -f "$PROJEKT/docker-compose.yml" exec -T matsal-meny \
    tar czf - -C /app data images > "$FIL"
fi

# kontrollera att arkivet går att läsa och innehåller menydatan
# (listan fångas först för att inte strypa tar-pipan med grep -q + pipefail)
ARKIVLISTA="$(tar tzf "$FIL")"
if ! printf '%s\n' "$ARKIVLISTA" | grep -q 'data/meals.json'; then
  rm -f "$FIL"
  echo "FEL: backupen saknar data/meals.json – arkivet kastades. Kontrollera att tjänsten körs." >&2
  exit 1
fi

# städa bort backups äldre än BEHALL dagar
find "$KATALOG" -name 'matsal-*.tar.gz' -mtime "+$BEHALL" -delete

echo "Backup klar: $FIL"
