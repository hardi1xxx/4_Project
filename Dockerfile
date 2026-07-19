FROM node:18-slim

WORKDIR /app

# Copy manifest dulu (supaya layer install bisa di-cache terpisah dari kode)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Baru copy semua source code
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
