import type { Request, Response } from 'express';
import { getCurrentUser } from './users.service';

export async function getMeController(_req: Request, res: Response) {
  res.status(200).json(await getCurrentUser(res.locals.userId as string));
}
