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

// ✅ 1. Archivos públicos/uploads
app.use("/public", express.static(uploadConfig.directory));

// ✅ 2. TODAS las rutas de API
app.use(routes);

// ✅ 3. Manejador de errores de Sentry
app.use(Sentry.Handlers.errorHandler());

// ✅ 4. Manejador de errores personalizado
app.use(async (err: Error, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof AppError) {
    logger.warn(err);
    return res.status(err.statusCode).json({ error: err.message });
  }

  logger.error(err);
  return res.status(500).json({ error: "Internal server error" });
});

// ✅ 5. Frontend estático DESPUÉS de los errores
app.use(express.static(path.join(__dirname, '../public')));

// ✅ 6. Catch-all para SPA (SOLO para rutas que no existen)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

export default app;
