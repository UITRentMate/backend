import express, { type Request, type Response } from 'express';
import { roomRouter } from './modules/rooms/room.routes';
import { errorHandler } from './common/middleware/error-handler';

export const app = express();

// CORS Middleware hỗ trợ Local Dev, FE (Next.js/React) và Web Swagger Editor
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'rentmate-backend',
  });
});

// Phân hệ Room Discovery (SEARCH-01 & SEARCH-02)
app.use(roomRouter);

// Global Error Handler Middleware
app.use(errorHandler);
