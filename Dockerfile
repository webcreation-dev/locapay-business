# --- Étape de Build du Frontend (React) ---
FROM node:20-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
# Build Vite et vérifie que index.html est bien généré
RUN npm run build && echo "✅ Build OK:" && ls dist/

# --- Étape de Runtime du Bot (Backend) ---
FROM node:20-slim
RUN apt-get update \
    && apt-get install -y git chromium fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*
ENV CHROME_BIN=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
# Copier le build React dans un dossier dédié (séparé de public/)
COPY --from=frontend-build /app/frontend/dist/ ./frontend-dist/
RUN echo "✅ React build dans frontend-dist:" && ls ./frontend-dist/
CMD ["sh", "-c", "rm -f /usr/src/app/.wwebjs_auth/session*/SingletonLock && node index.js"]
