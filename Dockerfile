# Multi-stage build para Whaticket completo
FROM node:18-alpine AS builder

# Instalar dependencias del sistema
RUN apk add --no-cache bash git

WORKDIR /app

# Copiar package.json de ambos
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/

# Instalar dependencias del backend
WORKDIR /app/backend
RUN npm install

# Instalar dependencias del frontend
WORKDIR /app/frontend
RUN npm install

# Copiar código completo
WORKDIR /app
COPY backend ./backend
COPY frontend ./frontend

# Compilar backend
WORKDIR /app/backend
RUN npm run build

# Compilar frontend
WORKDIR /app/frontend
RUN REACT_APP_BACKEND_URL=https://whaticket-community-production.up.railway.app npm run build

# Stage final
FROM node:18-alpine

RUN apk add --no-cache \
    bash \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app/backend

# Copiar backend compilado
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/backend/node_modules ./node_modules
COPY --from=builder /app/backend/package*.json ./

# Copiar frontend compilado para servirlo
COPY --from=builder /app/frontend/build ./public

# Instalar sequelize-cli
RUN npm install -g sequelize-cli

# Copiar archivos necesarios para migraciones
COPY --from=builder /app/backend/src ./src

EXPOSE 8080

CMD ["sh", "-c", "npx sequelize-cli db:migrate && npx sequelize-cli db:seed:all && npm start"]
