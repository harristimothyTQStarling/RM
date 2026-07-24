# TQStarling Resource Planner — Railway container
#
# One process serves the UI, the API and the Entra sign-in flow (api/src/server.js).
# Railway injects PORT and DATABASE_URL; everything else comes from service variables.

FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install deps first so layer caching survives source-only changes.
COPY api/package*.json ./api/
RUN cd api && npm ci --omit=dev

# App source. db/ is needed at runtime: migrate.js reads schema.postgres.sql.
COPY api/ ./api/
COPY web/ ./web/
COPY db/  ./db/

# Don't run as root.
USER node

EXPOSE 8080
CMD ["node", "api/src/server.js"]
