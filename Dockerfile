# Backend Dockerfile para Whaticket
FROM node:18-alpine

# Instalar dependencias del sistema
RUN apk add --no-cache \
    bash \
    git \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Variables de entorno para Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Establecer directorio de trabajo
WORKDIR /app

# Copiar package.json del backend
COPY backend/package*.json ./backend/

# Instalar dependencias
WORKDIR /app/backend
RUN npm install

# Copiar el resto del código
WORKDIR /app
COPY backend ./backend

# Compilar TypeScript
WORKDIR /app/backend
RUN npm run build

# Exponer puerto
EXPOSE 8080

# Comando de inicio (CAMBIO AQUÍ)
CMD ["npm", "start"]
