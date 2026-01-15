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

// 1. Archivos públicos/uploads (ANTES de las rutas API)
app.use("/public", express.static(uploadConfig.directory));

// 2. TODAS las rutas de API
app.use(routes);

// 3. Manejador de errores de Sentry
app.use(Sentry.Handlers.errorHandler());

// 4. Manejador de errores personalizado
app.use(async (err: Error, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof AppError) {
    logger.warn(err);
    return res.status(err.statusCode).json({ error: err.message });
  }

  logger.error(err);
  return res.status(500).json({ error: "Internal server error" });
});

// 5. Frontend estático (DESPUÉS del manejo de errores)
app.use(express.static(path.join(__dirname, '../public')));

// 6. Catch-all para SPA - SOLO para rutas que NO sean API
app.get('*', (req, res, next) => {
  // Si la ruta comienza con /api, /auth, etc., es una ruta API
  // y debe pasar al manejador de errores (404)
  if (req.path.startsWith('/api') || 
      req.path.startsWith('/auth') || 
      req.path.startsWith('/public') ||
      req.path.startsWith('/contacts') ||
      req.path.startsWith('/messages') ||
      req.path.startsWith('/tickets') ||
      req.path.startsWith('/whatsapp') ||
      req.path.startsWith('/queues') ||
      req.path.startsWith('/users') ||
      req.path.startsWith('/settings') ||
      req.path.startsWith('/quickanswers')) {
    // No enviar HTML, dejar que retorne error API
    return res.status(404).json({ error: "Not found" });
  }
  
  // Para rutas del frontend SPA, enviar index.html
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

export default app;
