FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . ./
RUN mkdir -p /app/data /app/runtime /app/generated /app/previews /app/output

EXPOSE 8789
CMD ["node", "server.mjs"]
