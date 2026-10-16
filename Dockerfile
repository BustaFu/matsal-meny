# syntax=docker/dockerfile:1

# ---------- Byggsteg: installera beroenden ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- Körsteg ----------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

# kör som icke-root-användare
RUN addgroup -S matsal && adduser -S matsal -G matsal

COPY --from=build /app/node_modules ./node_modules
COPY --chown=matsal:matsal src ./src
COPY --chown=matsal:matsal public ./public
COPY --chown=matsal:matsal data ./data
COPY --chown=matsal:matsal images ./images

# data och bilder ska kunna ändras i körande container (docker run -v / compose-volymer)
RUN chown -R matsal:matsal /app/data /app/images

USER matsal
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}${BASE_PATH-/meny}/api/menu/today >/dev/null || exit 1

CMD ["node", "src/server.js"]
