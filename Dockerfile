# syntax=docker/dockerfile:1

# Debian-slim (inte alpine): sharp:s färdiga binärer (glibc) fungerar direkt,
# ingen källkodsbyggnad av libvips behövs. Byggstadiet använder samma lockfil
# som värden, som innehåller glibc-varianten av sharp.

# ---------- Byggsteg: installera beroenden ----------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- Körsteg ----------
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app

# kör som icke-root: imaget inbyggda användaren "node" (uid/gid 1000).
# FAST uid är viktigt – datavolymer bevarar filägaren mellan image-byten.
COPY --from=build /app/node_modules ./node_modules
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node data ./data
COPY --chown=node:node images ./images

# data och bilder ska kunna ändras i körande container (docker run -v / compose-volymer)
RUN chown -R node:node /app/data /app/images

USER node
EXPOSE 3000

# hälsokoll med node (slim saknar wget) – följer PORT och BASE_PATH
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+process.env.BASE_PATH+'/api/menu/today').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
