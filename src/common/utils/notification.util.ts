import { Prisma, type PrismaClient } from '@prisma/client';

import type { NotificationEventType } from '../constants/phase3-status';

export type NotificationDbClient = PrismaClient | Prisma.TransactionClient;

export interface NotificationPayload {
  content?: string;
  actionUrl?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  metadata?: Record<string, Prisma.InputJsonValue | null | undefined>;
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
 * (tránh cắt đôi surrogate pair của emoji gây lỗi UTF-8) và từ chối tiêu đề rỗng/chỉ chứa khoảng trắng.
 */
export function normalizeNotificationTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new Error('Tiêu đề thông báo không được để trống');
  }
  const codePoints = [...trimmed];
  if (codePoints.length <= MAX_NOTIFICATION_TITLE_LENGTH) {
    return trimmed;
  }
  return codePoints.slice(0, MAX_NOTIFICATION_TITLE_LENGTH).join('');
}

const OMIT_JSON_VALUE = Symbol('OMIT_JSON_VALUE');

function sanitizeJsonValue(
  value: unknown,
  seen: WeakSet<object>,
): Prisma.InputJsonValue | null;
function sanitizeJsonValue(
  value: unknown,
  seen: WeakSet<object>,
  allowUndefined: true,
): Prisma.InputJsonValue | null | typeof OMIT_JSON_VALUE;
function sanitizeJsonValue(
  value: unknown,
  seen: WeakSet<object>,
  allowUndefined = false,
): Prisma.InputJsonValue | null | typeof OMIT_JSON_VALUE {
  if (value === undefined) {
    if (allowUndefined) {
      return OMIT_JSON_VALUE;
    }
    throw new TypeError('Payload thông báo chứa giá trị undefined không hợp lệ');
  }

  if (value === null) {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Payload thông báo chứa số không hợp lệ (NaN/Infinity)');
    }
    return value;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError('Payload thông báo chứa giá trị Date không hợp lệ');
    }
    return value.toISOString();
  }

  if (typeof value !== 'object') {
    throw new TypeError(`Payload thông báo chứa kiểu dữ liệu không hỗ trợ JSON: ${typeof value}`);
  }

  if (seen.has(value)) {
    throw new TypeError('Payload thông báo chứa tham chiếu vòng (circular reference)');
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const items: Array<Prisma.InputJsonValue | null> = [];
      for (const element of value) {
        if (element === undefined) {
          throw new TypeError('Payload thông báo chứa phần tử undefined trong mảng');
        }
        items.push(sanitizeJsonValue(element, seen));
      }
      return items;
    }

    const toJson = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJson === 'function') {
      const serialized = (toJson as () => unknown).call(value);
      return allowUndefined
        ? sanitizeJsonValue(serialized, seen, true)
        : sanitizeJsonValue(serialized, seen);
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError('Payload thông báo chỉ chấp nhận plain object hoặc giá trị JSON hợp lệ');
    }

    const record: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      const sanitizedEntry = sanitizeJsonValue(entryValue, seen, true);
      if (sanitizedEntry === OMIT_JSON_VALUE) {
        continue;
      }
      record[key] = sanitizedEntry;
    }
    return record;
  } finally {
    seen.delete(value);
  }
}

function normalizeNotificationPayload(
  payload: CreateNotificationInput['payload'],
): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (payload === undefined) {
    return undefined;
  }
  if (payload === null) {
    return Prisma.JsonNull;
  }
  const sanitized = sanitizeJsonValue(payload, new WeakSet<object>());
  return sanitized === null ? Prisma.JsonNull : sanitized;
}

function buildNotificationData(input: CreateNotificationInput): Prisma.NotificationCreateManyInput {
  return {
    recipientId: input.recipientId,
    title: normalizeNotificationTitle(input.title),
    eventType: input.eventType,
    payload: normalizeNotificationPayload(input.payload),
  };
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
    data: buildNotificationData(input),
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
    data: inputs.map(buildNotificationData),
  });
}
