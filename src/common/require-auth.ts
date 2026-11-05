import type { RequestHandler } from 'express';
import { HttpError } from './http-error';
import { verifyAccessToken } from '../modules/auth/auth.security';

export const requireAuth: RequestHandler = (req, res, next) => {
  const match = /^Bearer (\S+)$/i.exec(req.header('Authorization') ?? '');
  if (!match) throw new HttpError(401, 'UNAUTHORIZED', 'Cần access token');
  res.locals.userId = verifyAccessToken(match[1]);
  next();
};
