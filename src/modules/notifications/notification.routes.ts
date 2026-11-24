import { Router } from 'express';

import { requireActiveUser } from '../../common/middleware/require-role';
import { NotificationController } from './notification.controller';

export const notificationRouter = Router();

// Đặt các route tĩnh /unread-count và /read-all trước /:notificationId trong Express 5
notificationRouter.get(
  '/api/v1/notifications',
  requireActiveUser(),
  NotificationController.getNotifications,
);

notificationRouter.get(
  '/api/v1/notifications/unread-count',
  requireActiveUser(),
  NotificationController.getUnreadCount,
);

notificationRouter.patch(
  '/api/v1/notifications/read-all',
  requireActiveUser(),
  NotificationController.markAllAsRead,
);

notificationRouter.get(
  '/api/v1/notifications/:notificationId',
  requireActiveUser(),
  NotificationController.getNotificationDetail,
);

notificationRouter.patch(
  '/api/v1/notifications/:notificationId/read',
  requireActiveUser(),
  NotificationController.markAsRead,
);
