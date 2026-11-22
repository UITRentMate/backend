import { z } from 'zod';

import {
  NOTIFICATION_CATEGORY,
  type NotificationCategory,
} from '../../common/constants/phase3-status';
import { ApiError } from '../../common/errors/api-error';
import type { NotificationListQuery } from './notification.types';

const notificationIdSchema = z.string().uuid('Mã thông báo không đúng định dạng UUID');

const positiveIntFromQuery = (field: string, min: number, max?: number) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === '') {
        return undefined;
      }
      const parsed = Number(value);
      return Number.isInteger(parsed) ? parsed : value;
    },
    z
      .number({ message: `${field} phải là số nguyên` })
      .int(`${field} phải là số nguyên`)
      .min(min, `${field} phải lớn hơn hoặc bằng ${min}`)
      .refine((n) => (max === undefined ? true : n <= max), {
        message: `${field} không được vượt quá ${max}`,
      })
      .optional(),
  );

const booleanFromQuery = z.preprocess((value) => {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  return value;
}, z.boolean({ message: 'isRead phải là true hoặc false' }).optional());

const categoryValues = Object.values(NOTIFICATION_CATEGORY) as [
  NotificationCategory,
  ...NotificationCategory[],
];

const notificationListQuerySchema = z.object({
  page: positiveIntFromQuery('page', 1),
  limit: positiveIntFromQuery('limit', 1, 50),
  pageSize: positiveIntFromQuery('pageSize', 1, 50),
  isRead: booleanFromQuery,
  category: z.enum(categoryValues, { message: 'Danh mục thông báo không hợp lệ' }).optional(),
  eventType: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .regex(/^[A-Z0-9_]{1,40}$/, 'eventType chỉ được gồm chữ hoa, số, dấu gạch dưới (tối đa 40 ký tự)')
      .optional(),
  ),
});

function formatZodIssues(issues: z.ZodIssue[]): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    if (!errors[key]) {
      errors[key] = [];
    }
    errors[key].push(issue.message);
  }
  return errors;
}

export function validateNotificationId(rawId: unknown): string {
  const parsed = notificationIdSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Mã thông báo không hợp lệ', {
      notificationId: parsed.error.issues.map((issue) => issue.message),
    });
  }
  return parsed.data;
}

export function validateNotificationListQuery(rawQuery: unknown): NotificationListQuery {
  const parsed = notificationListQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'Tham số truy vấn thông báo không hợp lệ',
      formatZodIssues(parsed.error.issues),
    );
  }

  const data = parsed.data;
  const query: NotificationListQuery = {
    page: data.page ?? 1,
    limit: data.limit ?? data.pageSize ?? 20,
  };

  if (data.isRead !== undefined) {
    query.isRead = data.isRead;
  }
  if (data.category !== undefined) {
    query.category = data.category;
  }
  if (data.eventType !== undefined) {
    query.eventType = data.eventType;
  }

  return query;
}
