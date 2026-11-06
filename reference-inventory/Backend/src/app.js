import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import authRoutes from './routes/auth.routes.js';
import workspaceRoutes from './routes/workspace.routes.js';
import purchaseOrderRoutes from './routes/purchase-order.routes.js';
import aiRoutes from './routes/ai.routes.js';
import cronRoutes from './routes/cron.routes.js';
import { env } from './config/env.js';
import crypto from 'node:crypto';

const allowedOrigins = env.FRONTEND_ORIGIN
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    const cleanOrigin = origin.replace(/\/$/, '');
    if (
      allowedOrigins.includes(cleanOrigin) ||
      cleanOrigin.endsWith('.netlify.app') ||
      cleanOrigin === 'https://netlify.app' ||
      cleanOrigin.endsWith('.kitaundang.web.id') ||
      cleanOrigin === 'https://kitaundang.web.id' ||
      cleanOrigin.endsWith('.kitaundang.my.id') ||
      cleanOrigin === 'https://kitaundang.my.id' ||
      cleanOrigin.endsWith('.notha.my.id') ||
      cleanOrigin === 'https://notha.my.id' ||
      cleanOrigin.endsWith('.vercel.app') ||
      cleanOrigin === 'https://vercel.app' ||

      cleanOrigin.startsWith('http://localhost:') ||
      cleanOrigin.startsWith('http://127.0.0.1:') ||
      cleanOrigin === 'http://localhost' ||
      cleanOrigin === 'http://127.0.0.1'
    ) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: true,
};

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => {
    const requestId = String(req.headers['x-request-id'] || crypto.randomUUID());
    const startedAt = process.hrtime.bigint();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      if (durationMs >= 500) {
        console.warn(JSON.stringify({
          event: 'slow_request', requestId, method: req.method, path: req.originalUrl,
          status: res.statusCode, durationMs: Math.round(durationMs),
        }));
      }
    });
    next();
  });
  app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

  app.get('/', (_req, res) => {
    res.json({ ok: true, service: 'docuflow-backend', routes: ['/health', '/api'] });
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'docuflow-backend' });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/workspace', purchaseOrderRoutes);
  app.use('/api/workspace', aiRoutes);
  app.use('/api/workspace', workspaceRoutes);
  // Cron worker: sengaja TIDAK dipasang di bawah /api/workspace (yang
  // mewajibkan requireAuth/loadTenant berbasis sesi user). Endpoint ini
  // dipicu oleh Vercel Cron / cron eksternal tanpa sesi user, dan dilindungi
  // sendiri oleh CRON_SECRET di dalam cron.routes.js.
  app.use('/api/cron', cronRoutes);

  app.use((req, res) => {
    res.status(404).json({
      error: {
        message: `Route not found: ${req.method} ${req.path}`,
      },
    });
  });

  app.use((error, _req, res, _next) => {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        error: {
          message: 'Invalid request payload',
          details: error.issues,
        },
      });
    }

    const status = error.status ?? 500;
    const isDev = env.NODE_ENV !== 'production';
    return res.status(status).json({
      error: {
        message: error.message ?? 'Internal server error',
        ...(error.code ? { code: error.code } : {}),
        ...(isDev && error.details ? { details: error.details } : {}),
      },
    });
  });

  return app;
}
