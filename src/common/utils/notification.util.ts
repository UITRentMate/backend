import { Prisma, type PrismaClient } from '@prisma/client';

import type { NotificationEventType } from '../constants/phase3-status';

export type NotificationDbClient = PrismaClient | Prisma.TransactionClient;

export interface NotificationPayload {
  content?: string;
  actionUrl?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateNotificationInput {
  recipientId: string;
  title: string;
  eventType: NotificationEventType | string;
  payload?: NotificationPayload | Prisma.InputJsonValue | null;
}

const MAX_NOTIFICATION_TITLE_LENGTH = 200;

/**
 * Chuẩn hóa tiêu đề thông báo vừa khít giới hạn VARCHAR(200) của PostgreSQL theo Unicode code point
 * (tránh cắt đôi surrogate pair của emoji gây lỗi UTF-8).
 */
export function normalizeNotificationTitle(title: string): string {
  const trimmed = title.trim();
  const codePoints = [...trimmed];
  if (codePoints.length <= MAX_NOTIFICATION_TITLE_LENGTH) {
    return trimmed;
  }
  return codePoints.slice(0, MAX_NOTIFICATION_TITLE_LENGTH).join('');
}

/**
 * Tạo một thông báo In-App cho người dùng.
 * Nhận được cả PrismaClient lẫn Prisma.TransactionClient.
 */
export async function createNotification(
  db: NotificationDbClient,
  input: CreateNotificationInput,
) {
  return db.notification.create({
    data: {
      recipientId: input.recipientId,
      title: normalizeNotificationTitle(input.title),
      eventType: input.eventType,
      payload:
        input.payload === undefined
          ? undefined
          : input.payload === null
            ? Prisma.JsonNull
            : (input.payload as Prisma.InputJsonValue),
    },
  });
}

/**
 * Tạo hàng loạt thông báo In-App (ví dụ khi tự động từ chối nhiều yêu cầu thuê cạnh tranh).
 */
export async function createNotificationsBatch(
  db: NotificationDbClient,
  inputs: readonly CreateNotificationInput[],
) {
  if (inputs.length === 0) {
    return { count: 0 };
  }

  return db.notification.createMany({
    data: inputs.map((item) => ({
      recipientId: item.recipientId,
      title: normalizeNotificationTitle(item.title),
      eventType: item.eventType,
      payload:
        item.payload === undefined
          ? undefined
          : item.payload === null
            ? Prisma.JsonNull
            : (item.payload as Prisma.InputJsonValue),
    })),
  });
}
