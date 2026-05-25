FROM oven/bun:1.3-alpine AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./

RUN addgroup -S app && adduser -S -G app app
RUN mkdir -p /app/data && chown -R app:app /app
USER app

EXPOSE 8002
ENV HOSTNAME=0.0.0.0
ENV PORT=8002

CMD ["bun", "run", "src/server.ts"]
