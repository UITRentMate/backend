import express, { type Request, type Response } from 'express';

export const app = express();

app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'rentmate-backend',
  });
});
