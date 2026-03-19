FROM node:20-slim

# Installation de Chromium et des dépendances nécessaires pour faire tourner Puppeteer
RUN apt-get update \
    && apt-get install -y chromium fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Définition des variables d'environnement cruciales
ENV CHROME_BIN=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Création du répertoire de l'application
WORKDIR /usr/src/app

# Copie des fichiers de configuration NPM
COPY package*.json ./

# Installation des dépendances NPM
RUN npm install

# Copie du reste des fichiers du projet
COPY . .

# Démarre l'application en nettoyant au préalable tout fichier de verrouillage Chrome corrompu
CMD ["sh", "-c", "rm -f /usr/src/app/.wwebjs_auth/session*/SingletonLock && node index.js"]
