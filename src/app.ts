import express, { type Request, type Response } from 'express';

import { errorHandler } from './common/middleware/error-handler';

import { authRoutes } from './modules/auth/auth.routes';
import { propertyRouter } from './modules/properties/property.routes';
import { roomRouter } from './modules/rooms/room.routes';
import { usersRoutes } from './modules/users/users.routes';

export const app = express();

app.use((req, res, next) => {
  const origin = req.header('Origin');
  if (origin) {
    res.vary('Origin');
    const allowedOrigins = new Set(
      (process.env.CORS_ORIGINS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    );

    if (allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

      if (req.header('Access-Control-Request-Private-Network') === 'true') {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
    }
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json());
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', usersRoutes);

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'rentmate-backend',
  });
});

// Phân hệ Room Discovery (SEARCH-01 & SEARCH-02)
app.use(roomRouter);

// Phân hệ Quản lý & Chi tiết Khu trọ (BE-P2-01)
app.use(propertyRouter);

// Global Error Handler Middleware
app.use(errorHandler);
