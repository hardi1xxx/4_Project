FROM node:18-slim

WORKDIR /app

COPY . .

RUN npm install --omit=dev

# Verifikasi: kalau langkah ini gagal atau express tidak muncul di log,
# berarti masalahnya ada di proses install ini, bukan di runtime.
RUN ls -la node_modules | head -5 && test -d node_modules/express && echo "OK: express terinstall"

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]