import { getNotificationCategory } from '../../common/constants/phase3-status';
import type { NotificationItemDTO, NotificationRecord } from './notification.types';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalString(record: Record<string, unknown> | null, key: string): string | null {
  if (!record) {
    return null;
  }
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Chuyển đổi bản ghi Notification từ Prisma sang NotificationItemDTO chuẩn.
 * Xử lý an toàn khi payload là null hoặc không phải plain object, và fallback category = SYSTEM.
 */
export function mapToNotificationDTO(row: NotificationRecord): NotificationItemDTO {
  const payloadObj = isPlainRecord(row.payload) ? row.payload : null;

  return {
    id: row.id,
    eventType: row.eventType,
    category: getNotificationCategory(row.eventType),
    title: row.title,
    content: readOptionalString(payloadObj, 'content'),
    actionUrl: readOptionalString(payloadObj, 'actionUrl'),
    relatedEntityType: readOptionalString(payloadObj, 'relatedEntityType'),
    relatedEntityId: readOptionalString(payloadObj, 'relatedEntityId'),
    payload: payloadObj,
    isRead: row.isRead,
    createdAt: row.createdAt.toISOString(),
  };
}
