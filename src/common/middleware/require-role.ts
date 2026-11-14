import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ApiError } from '../errors/api-error';
import { prisma } from '../../infrastructure/database/prisma';
import { verifyAccessToken } from '../../modules/auth/auth.security';

export type UserRole = 'TENANT' | 'LANDLORD' | 'ADMIN';

export interface CurrentUser {
  id: string;
  role: string;
  accountStatus: string;
  fullName: string;
}

declare global {
  namespace Express {
    interface Locals {
      userId?: string;
      currentUser?: CurrentUser;
    }
  }
}

/**
 * requireRole middleware factory
 * - Verifies access token if res.locals.userId is not already populated
 * - Loads current user from DB using Prisma singleton, selecting only id, role, accountStatus, fullName (never passwordHash)
 * - Requires accountStatus === 'ACTIVE'
 * - Verifies user.role matches one of allowedRoles (if specified)
 * - Assigns typed user to res.locals.currentUser for downstream reuse
 */
export function requireRole(...allowedRoles: ('TENANT' | 'LANDLORD' | 'ADMIN')[]): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      let userId = res.locals.userId;
      if (!userId) {
        const match = /^Bearer (\S+)$/i.exec(req.header('Authorization') ?? '');
        if (!match) {
          throw new ApiError(401, 'UNAUTHORIZED', 'Cần access token');
        }
        userId = verifyAccessToken(match[1]);
        res.locals.userId = userId;
      }

      let user = res.locals.currentUser;
      if (!user || user.id !== userId) {
        const dbUser = await prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            role: true,
            accountStatus: true,
            fullName: true,
          },
        });

        if (!dbUser) {
          throw new ApiError(401, 'UNAUTHORIZED', 'Tài khoản không tồn tại hoặc phiên đăng nhập không hợp lệ');
        }

        user = dbUser;
        res.locals.currentUser = user;
      }

      if (user.accountStatus !== 'ACTIVE') {
        throw new ApiError(403, 'ACCOUNT_LOCKED', 'Tài khoản đã bị khóa hoặc chưa kích hoạt');
      }

      if (allowedRoles.length > 0 && !allowedRoles.includes(user.role as UserRole)) {
        throw new ApiError(403, 'FORBIDDEN', 'Bạn không có quyền thực hiện thao tác này');
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * requireActiveUser middleware
 * Accepts any active user regardless of role.
 * Can be used either as a middleware directly or called as a factory.
 */
export function requireActiveUser(): RequestHandler;
export function requireActiveUser(req: Request, res: Response, next: NextFunction): void | Promise<void>;
export function requireActiveUser(
  reqOrNothing?: Request,
  res?: Response,
  next?: NextFunction,
): RequestHandler | Promise<void> | void {
  const handler = requireRole();
  if (reqOrNothing && res && next) {
    return handler(reqOrNothing, res, next) as void | Promise<void>;
  }
  return handler;
}
