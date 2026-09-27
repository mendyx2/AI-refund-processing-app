# Used by both the one-shot db-seed job and the API server (see docker-compose.yml).
# Full (non-slim) image: Prisma's schema engine needs OpenSSL, which slim lacks.
FROM node:22

WORKDIR /app

COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY data ./data

ENV PORT=8000
EXPOSE 8000
CMD ["node", "--import", "tsx", "src/server.ts"]
