import express, { type Request, type Response } from 'express';
import { errorHandler } from './common/http-error';
import { authRoutes } from './modules/auth/auth.routes';
import { usersRoutes } from './modules/users/users.routes';

export const app = express();

app.use(express.json());
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', usersRoutes);

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'rentmate-backend',
  });
});

app.use(errorHandler);
