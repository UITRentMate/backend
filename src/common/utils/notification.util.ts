import { Prisma, type PrismaClient } from '@prisma/client';

import type { NotificationEventType } from '../constants/phase3-status';

export type NotificationDbClient = PrismaClient | Prisma.TransactionClient;

export interface CreateNotificationInput {
  recipientId: string;
  title: string;
  eventType: NotificationEventType | string;
  payload?: Prisma.InputJsonValue | null;
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
      title: input.title,
      eventType: input.eventType,
      payload:
        input.payload === undefined
          ? undefined
          : input.payload === null
            ? Prisma.JsonNull
            : input.payload,
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
      title: item.title,
      eventType: item.eventType,
      payload:
        item.payload === undefined
          ? undefined
          : item.payload === null
            ? Prisma.JsonNull
            : item.payload,
    })),
  });
}
