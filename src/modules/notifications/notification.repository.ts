import type { Prisma } from '@prisma/client';

import {
  getEventTypesByCategory,
  NOTIFICATION_CATEGORY,
  type NotificationCategory,
} from '../../common/constants/phase3-status';
import { prisma } from '../../infrastructure/database/prisma';
import type { NotificationListQuery, NotificationRecord } from './notification.types';

const NOTIFICATION_SELECT = {
  id: true,
  recipientId: true,
  title: true,
  eventType: true,
  payload: true,
  isRead: true,
  createdAt: true,
} as const satisfies Prisma.NotificationSelect;

function buildCategoryFilterCondition(
  category: NotificationCategory,
): Prisma.NotificationWhereInput {
  if (category === NOTIFICATION_CATEGORY.SYSTEM) {
    // Khớp với fallback category = SYSTEM của getNotificationCategory():
    // bao gồm các event SYSTEM đã khai báo và mọi event mới chưa thuộc 3 nhóm nghiệp vụ còn lại.
    const nonSystemEvents = [
      ...getEventTypesByCategory(NOTIFICATION_CATEGORY.BOOKING_CONTRACT),
      ...getEventTypesByCategory(NOTIFICATION_CATEGORY.FINANCE),
      ...getEventTypesByCategory(NOTIFICATION_CATEGORY.REPAIR),
    ];
    return {
      eventType: {
        notIn: nonSystemEvents,
      },
    };
  }

  return {
    eventType: {
      in: [...getEventTypesByCategory(category)],
    },
  };
}

async function findAndMarkSingleNotificationAsRead(
  recipientId: string,
  notificationId: string,
): Promise<{ notification: NotificationRecord; unreadCount: number } | null> {
  const existing = await prisma.notification.findFirst({
    where: {
      id: notificationId,
      recipientId,
    },
    select: NOTIFICATION_SELECT,
  });

  if (!existing) {
    return null;
  }

  // Read-only fast path: trạng thái isRead chỉ chuyển một chiều false -> true,
  // nên nếu đã đọc rồi thì không cần mở transaction ghi mà chỉ đếm unreadCount.
  if (existing.isRead) {
    const unreadCount = await prisma.notification.count({
      where: {
        recipientId,
        isRead: false,
      },
    });

    return {
      notification: existing,
      unreadCount,
    };
  }

  return prisma.$transaction(async (tx) => {
    await tx.notification.updateMany({
      where: {
        id: notificationId,
        recipientId,
        isRead: false,
      },
      data: {
        isRead: true,
      },
    });

    const unreadCount = await tx.notification.count({
      where: {
        recipientId,
        isRead: false,
      },
    });

    return {
      notification: { ...existing, isRead: true },
      unreadCount,
    };
  });
}

export class NotificationRepository {
  public static async findNotificationsList(
    recipientId: string,
    query: NotificationListQuery,
  ): Promise<{ items: NotificationRecord[]; total: number; unreadCount: number }> {
    const where: Prisma.NotificationWhereInput = {
      recipientId,
    };

    if (query.isRead !== undefined) {
      where.isRead = query.isRead;
    }

    const andConditions: Prisma.NotificationWhereInput[] = [];
    if (query.category !== undefined) {
      andConditions.push(buildCategoryFilterCondition(query.category));
    }
    if (query.eventType !== undefined) {
      andConditions.push({ eventType: query.eventType });
    }
    if (andConditions.length === 1) {
      Object.assign(where, andConditions[0]);
    } else if (andConditions.length > 1) {
      where.AND = andConditions;
    }

    const skip = (query.page - 1) * query.limit;
    const take = query.limit;

    const [items, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        skip,
        take,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: NOTIFICATION_SELECT,
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({
        where: {
          recipientId,
          isRead: false,
        },
      }),
    ]);

    return { items, total, unreadCount };
  }

  public static async countUnread(recipientId: string): Promise<number> {
    return prisma.notification.count({
      where: {
        recipientId,
        isRead: false,
      },
    });
  }

  public static async findByIdAndMarkRead(
    recipientId: string,
    notificationId: string,
  ): Promise<{ notification: NotificationRecord; unreadCount: number } | null> {
    return findAndMarkSingleNotificationAsRead(recipientId, notificationId);
  }

  public static async markOneAsRead(
    recipientId: string,
    notificationId: string,
  ): Promise<{ notification: NotificationRecord; unreadCount: number } | null> {
    return findAndMarkSingleNotificationAsRead(recipientId, notificationId);
  }

  public static async markAllAsRead(
    recipientId: string,
  ): Promise<{ updatedCount: number; unreadCount: number }> {
    const result = await prisma.notification.updateMany({
      where: {
        recipientId,
        isRead: false,
      },
      data: {
        isRead: true,
      },
    });

    return {
      updatedCount: result.count,
      unreadCount: 0,
    };
  }
}
