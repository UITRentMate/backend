import type { RequestHandler } from 'express';
import { ApiError } from '../errors/api-error';
import { prisma } from '../../infrastructure/database/prisma';

export function requireRole(...allowedRoles: string[]): RequestHandler {
  return async (_req, res, next) => {
    try {
      const userId = res.locals.userId as string | undefined;
      if (!userId) {
        throw new ApiError(401, 'UNAUTHORIZED', 'Cần đăng nhập để thực hiện');
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true, accountStatus: true },
      });

      if (!user) {
        throw new ApiError(401, 'UNAUTHORIZED', 'Tài khoản không tồn tại');
      }

      if (user.accountStatus !== 'ACTIVE') {
        throw new ApiError(403, 'ACCOUNT_LOCKED', 'Tài khoản không thể truy cập');
      }

      if (!allowedRoles.includes(user.role)) {
        throw new ApiError(403, 'FORBIDDEN', 'Bạn không có quyền thực hiện thao tác này');
      }

      res.locals.currentUser = user;
      next();
    } catch (error) {
      next(error);
    }
  };
}
