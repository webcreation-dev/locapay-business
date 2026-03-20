# --- Étape de Build du Frontend (React) ---
FROM node:20-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# --- Étape de Runtime du Bot (Backend) ---
FROM node:20-slim
RUN apt-get update \
    && apt-get install -y chromium fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*
ENV CHROME_BIN=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
# On remplace l'ancien dossier public par le nouveau build React optimisé
COPY --from=frontend-build /app/frontend/dist ./public
CMD ["sh", "-c", "rm -f /usr/src/app/.wwebjs_auth/session*/SingletonLock && node index.js"]
