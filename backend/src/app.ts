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

// Servir archivos estáticos de uploads
app.use("/public", express.static(uploadConfig.directory));

// ✅ IMPORTANTE: Rutas API primero
app.use(routes);

// Manejador de errores de Sentry
app.use(Sentry.Handlers.errorHandler());

// Servir archivos estáticos del frontend
app.use(express.static(path.join(__dirname, '../public')));

// ✅ CORREGIDO: Solo redirigir rutas que NO son de API
// Las rutas de API típicamente empiezan con /api, /auth, etc.
app.get('*', (req, res, next) => {
  // Si es una ruta de API, no redirigir
  if (req.path.startsWith('/api') || 
      req.path.startsWith('/auth') || 
      req.path.startsWith('/public') ||
      req.path.startsWith('/contacts') ||
      req.path.startsWith('/messages') ||
      req.path.startsWith('/tickets') ||
      req.path.startsWith('/whatsapp') ||
      req.path.startsWith('/queues') ||
      req.path.startsWith('/users')) {
    return next(); // Dejar que el manejador de errores lo procese
  }
  
  // Para otras rutas, servir el frontend
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Manejador de errores global
app.use(async (err: Error, req: Request, res: Response, _: NextFunction) => {
  if (err instanceof AppError) {
    logger.warn(err);
    return res.status(err.statusCode).json({ error: err.message });
  }

  logger.error(err);
  return res.status(500).json({ error: "Internal server error" });
});

export default app;

