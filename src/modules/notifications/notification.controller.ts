import type { NextFunction, Request, Response } from 'express';

import { ApiError } from '../../common/errors/api-error';
import { NotificationService } from './notification.service';
import {
  validateNotificationId,
  validateNotificationListQuery,
} from './notification.validation';

function requireCurrentUserId(res: Response): string {
  const user = res.locals.currentUser;
  if (!user) {
    throw new ApiError(
      401,
      'UNAUTHORIZED',
      'Tài khoản không tồn tại hoặc phiên đăng nhập không hợp lệ',
    );
  }
  return user.id;
}

export class NotificationController {
  public static async getNotifications(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = requireCurrentUserId(res);
      const query = validateNotificationListQuery(req.query);
      const result = await NotificationService.getNotifications(userId, query);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  public static async getUnreadCount(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = requireCurrentUserId(res);
      const result = await NotificationService.getUnreadCount(userId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  public static async getNotificationDetail(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = requireCurrentUserId(res);
      const notificationId = validateNotificationId(req.params.notificationId);
      const result = await NotificationService.getNotificationDetail(userId, notificationId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  public static async markAsRead(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = requireCurrentUserId(res);
      const notificationId = validateNotificationId(req.params.notificationId);
      const result = await NotificationService.markAsRead(userId, notificationId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  public static async markAllAsRead(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = requireCurrentUserId(res);
      const result = await NotificationService.markAllAsRead(userId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
}
