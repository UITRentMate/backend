import type { RequestHandler } from 'express';
import { ApiError } from './errors/api-error';
import { verifyAccessToken } from '../modules/auth/auth.security';

export const requireAuth: RequestHandler = (req, res, next) => {
  const match = /^Bearer (\S+)$/i.exec(req.header('Authorization') ?? '');
  if (!match) throw new ApiError(401, 'UNAUTHORIZED', 'Cần access token');
  res.locals.userId = verifyAccessToken(match[1]);
  next();
};
