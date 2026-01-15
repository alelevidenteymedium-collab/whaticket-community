import "./bootstrap";
import "reflect-metadata";
import "express-async-errors";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import * as Sentry from "@sentry/node";
import path from 'path';
import "./database";
import uploadConfig from "./config/upload";
import AppError from "./errors/AppError";
import routes from "./routes";
import { logger } from "./utils/logger";

Sentry.init({ dsn: process.env.SENTRY_DSN });

const app = express();

app.use(
  cors({
    credentials: true,
    origin: process.env.FRONTEND_URL
  })
);
app.use(cookieParser());
app.use(express.json());
app.use(Sentry.Handlers.requestHandler());

// Archivos estáticos para uploads
app.use("/public", express.static(uploadConfig.directory));

// TODAS las rutas API
app.use(routes);

// Manejador de errores de Sentry
app.use(Sentry.Handlers.errorHandler());

// ✅ MANEJADOR DE ERRORES - ANTES del frontend estático
app.use(async (err: Error, req: Request, res: Response, next: NextFunction) => {
  // Si ya se envió una respuesta, no hacer nada
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof AppError) {
    // ✅ NO loggear errores JWT repetitivos (son del frontend)
    if (err.message !== "jwt must be provided") {
      logger.warn(err);
    }
    return res.status(err.statusCode).json({ error: err.message });
  }

  logger.error(err);
  return res.status(500).json({ error: "Internal server error" });
});

// Frontend estático (DESPUÉS del manejo de errores)
app.use(express.static(path.join(__dirname, '../public')));

// ✅ Catch-all para SPA - MUY ESPECÍFICO
app.get('*', (req, res) => {
  // Lista de prefijos de rutas API
  const apiPaths = [
    '/api',
    '/auth', 
    '/contacts',
    '/messages',
    '/tickets',
    '/whatsapp',
    '/queues',
    '/users',
    '/settings',
    '/quickanswers',
    '/quick-answers',
    '/tags',
    '/chatbot',
    '/webhooks'
  ];

  // Si es una ruta API, retornar 404 JSON
  if (apiPaths.some(path => req.path.startsWith(path))) {
    return res.status(404).json({ error: "Not found" });
  }

  // Para cualquier otra ruta, servir el frontend SPA
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

export default app;
