import { ApiError } from '../../common/errors/api-error';
import { mapToNotificationDTO } from './notification.mapper';
import { NotificationRepository } from './notification.repository';
import type {
  MarkAllNotificationsReadDTO,
  NotificationActionResponseDTO,
  NotificationListQuery,
  PaginatedNotificationsDTO,
  UnreadCountDTO,
} from './notification.types';

function throwNotificationNotFound(): never {
  throw new ApiError(
    404,
    'NOTIFICATION_NOT_FOUND',
    'Thông báo không tồn tại hoặc bạn không có quyền truy cập',
  );
}

export class NotificationService {
  public static async getNotifications(
    recipientId: string,
    query: NotificationListQuery,
  ): Promise<PaginatedNotificationsDTO> {
    const { items, total, unreadCount } = await NotificationRepository.findNotificationsList(
      recipientId,
      query,
    );

    return {
      items: items.map(mapToNotificationDTO),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: total === 0 ? 0 : Math.ceil(total / query.limit),
      unreadCount,
    };
  }

  public static async getUnreadCount(recipientId: string): Promise<UnreadCountDTO> {
    const unreadCount = await NotificationRepository.countUnread(recipientId);
    return { unreadCount };
  }

  public static async getNotificationDetail(
    recipientId: string,
    notificationId: string,
  ): Promise<NotificationActionResponseDTO> {
    const result = await NotificationRepository.findByIdAndMarkRead(recipientId, notificationId);
    if (!result) {
      throwNotificationNotFound();
    }

    return {
      ...mapToNotificationDTO(result.notification),
      unreadCount: result.unreadCount,
    };
  }

  public static async markAsRead(
    recipientId: string,
    notificationId: string,
  ): Promise<NotificationActionResponseDTO> {
    const result = await NotificationRepository.markOneAsRead(recipientId, notificationId);
    if (!result) {
      throwNotificationNotFound();
    }

    return {
      ...mapToNotificationDTO(result.notification),
      unreadCount: result.unreadCount,
    };
  }

  public static async markAllAsRead(recipientId: string): Promise<MarkAllNotificationsReadDTO> {
    return NotificationRepository.markAllAsRead(recipientId);
  }
}
