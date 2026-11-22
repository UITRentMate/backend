import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';

import {
  NOTIFICATION_CATEGORY,
  NOTIFICATION_EVENT_TYPE,
} from '../../src/common/constants/phase3-status';
import { ApiError } from '../../src/common/errors/api-error';
import { prisma } from '../../src/infrastructure/database/prisma';
import { NotificationRepository } from '../../src/modules/notifications/notification.repository';
import { NotificationService } from '../../src/modules/notifications/notification.service';

const undo: Array<() => void> = [];
afterEach(() => {
  while (undo.length) {
    undo.pop()!();
  }
});

function stub(delegate: any, name: string, implementation: (...args: any[]) => any) {
  const original = delegate[name];
  delegate[name] = implementation;
  undo.push(() => {
    delegate[name] = original;
  });
}

describe('Notification Repository & Service', () => {
  test('notification.service.ts không import Prisma Client trực tiếp', () => {
    const serviceSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/modules/notifications/notification.service.ts'),
      'utf8',
    );
    assert.ok(!serviceSource.includes('infrastructure/database/prisma'));
    assert.ok(!serviceSource.includes('@prisma/client'));
  });

  test('NotificationRepository.findNotificationsList lọc theo recipientId, sort deterministic và kết hợp AND khi cross-filter category + eventType', async () => {
    let findManyArgs: any;
    let countArgsList: any[] = [];

    stub(prisma.notification, 'findMany', async (args: any) => {
      findManyArgs = args;
      return [];
    });
    stub(prisma.notification, 'count', async (args: any) => {
      countArgsList.push(args);
      return 0;
    });

    const userId = '550e8400-e29b-41d4-a716-446655440010';
    await NotificationRepository.findNotificationsList(userId, {
      page: 2,
      limit: 10,
      isRead: false,
      category: NOTIFICATION_CATEGORY.FINANCE,
      eventType: NOTIFICATION_EVENT_TYPE.REPAIR_TICKET_CREATED,
    });

    assert.equal(findManyArgs.skip, 10);
    assert.equal(findManyArgs.take, 10);
    assert.deepEqual(findManyArgs.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
    assert.equal(findManyArgs.where.recipientId, userId);
    assert.equal(findManyArgs.where.isRead, false);
    assert.ok(Array.isArray(findManyArgs.where.AND));
    assert.equal(findManyArgs.where.AND.length, 2);

    // count thứ 2 là unreadCount toàn cục của user (chỉ lọc recipientId + isRead: false)
    assert.equal(countArgsList.length, 2);
    assert.deepEqual(countArgsList[1].where, { recipientId: userId, isRead: false });

    // Lọc category=SYSTEM dùng notIn các nhóm còn lại để khớp fallback getNotificationCategory
    await NotificationRepository.findNotificationsList(userId, {
      page: 1,
      limit: 20,
      category: NOTIFICATION_CATEGORY.SYSTEM,
    });
    assert.ok(Array.isArray(findManyArgs.where.eventType?.notIn));
    assert.ok(findManyArgs.where.eventType.notIn.includes(NOTIFICATION_EVENT_TYPE.DEPOSIT_CONFIRMED));
  });

  test('NotificationService tính totalPages chính xác và ném 404 khi thông báo không thuộc sở hữu', async () => {
    const userId = '550e8400-e29b-41d4-a716-446655440010';
    const notifId = '550e8400-e29b-41d4-a716-446655440020';

    stub(NotificationRepository, 'findNotificationsList', async () => ({
      items: [],
      total: 0,
      unreadCount: 3,
    }));

    const emptyList = await NotificationService.getNotifications(userId, { page: 1, limit: 20 });
    assert.equal(emptyList.totalPages, 0);
    assert.equal(emptyList.unreadCount, 3);

    stub(NotificationRepository, 'findByIdAndMarkRead', async () => null);
    await assert.rejects(
      () => NotificationService.getNotificationDetail(userId, notifId),
      (err: unknown) => err instanceof ApiError && err.statusCode === 404 && err.code === 'NOTIFICATION_NOT_FOUND',
    );

    stub(NotificationRepository, 'markOneAsRead', async () => null);
    await assert.rejects(
      () => NotificationService.markAsRead(userId, notifId),
      (err: unknown) => err instanceof ApiError && err.statusCode === 404 && err.code === 'NOTIFICATION_NOT_FOUND',
    );
  });

  test('NotificationService trả object phẳng kèm unreadCount cho detail và markAsRead', async () => {
    const userId = '550e8400-e29b-41d4-a716-446655440010';
    const notifId = '550e8400-e29b-41d4-a716-446655440020';
    const record = {
      id: notifId,
      recipientId: userId,
      title: 'Cập nhật lịch hẹn',
      eventType: NOTIFICATION_EVENT_TYPE.VIEWING_APPOINTMENT_CONFIRMED,
      payload: { content: 'Chủ trọ đã xác nhận.', actionUrl: '/viewing-appointments/1' },
      isRead: true,
      createdAt: new Date('2026-11-22T03:00:00.000Z'),
    };

    stub(NotificationRepository, 'findByIdAndMarkRead', async () => ({
      notification: record,
      unreadCount: 2,
    }));

    const detail = await NotificationService.getNotificationDetail(userId, notifId);
    assert.equal(detail.id, notifId);
    assert.equal(detail.category, NOTIFICATION_CATEGORY.BOOKING_CONTRACT);
    assert.equal(detail.content, 'Chủ trọ đã xác nhận.');
    assert.equal(detail.isRead, true);
    assert.equal(detail.unreadCount, 2);
  });
});
