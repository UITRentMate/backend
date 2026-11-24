import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ApiError } from '../../src/common/errors/api-error';
import {
  NOTIFICATION_CATEGORY,
  NOTIFICATION_EVENT_TYPE,
} from '../../src/common/constants/phase3-status';
import {
  createNotification,
  normalizeNotificationTitle,
} from '../../src/common/utils/notification.util';
import { mapToNotificationDTO } from '../../src/modules/notifications/notification.mapper';
import {
  MAX_NOTIFICATION_PAGE,
  validateNotificationId,
  validateNotificationListQuery,
} from '../../src/modules/notifications/notification.validation';

describe('Notification Validation & Mapper', () => {
  test('validateNotificationId chấp nhận UUID hợp lệ và ném 400 với chuỗi sai', () => {
    const validId = '550e8400-e29b-41d4-a716-446655440000';
    assert.equal(validateNotificationId(validId), validId);

    assert.throws(
      () => validateNotificationId('not-a-uuid'),
      (err: unknown) => err instanceof ApiError && err.statusCode === 400 && err.code === 'VALIDATION_ERROR',
    );
  });

  test('validateNotificationListQuery áp dụng mặc định, hỗ trợ alias pageSize và lọc hợp lệ', () => {
    assert.deepEqual(validateNotificationListQuery({}), {
      page: 1,
      limit: 20,
    });

    assert.deepEqual(
      validateNotificationListQuery({
        page: '2',
        pageSize: '15',
        isRead: 'false',
        category: NOTIFICATION_CATEGORY.FINANCE,
        eventType: 'INVOICE_ISSUED',
      }),
      {
        page: 2,
        limit: 15,
        isRead: false,
        category: NOTIFICATION_CATEGORY.FINANCE,
        eventType: 'INVOICE_ISSUED',
      },
    );

    // Ưu tiên limit khi truyền cả limit và pageSize, bỏ qua chuỗi rỗng ''
    assert.deepEqual(validateNotificationListQuery({ limit: '10', pageSize: '30', category: '', isRead: '', eventType: '' }), {
      page: 1,
      limit: 10,
    });

    // Từ chối limit > 50, page <= 0, category sai, eventType sai định dạng
    assert.throws(
      () => validateNotificationListQuery({ limit: '51' }),
      (err: unknown) => err instanceof ApiError && err.statusCode === 400 && err.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => validateNotificationListQuery({ page: '0' }),
      (err: unknown) => err instanceof ApiError && err.statusCode === 400 && err.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => validateNotificationListQuery({ category: 'UNKNOWN' }),
      (err: unknown) => err instanceof ApiError && err.statusCode === 400 && err.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => validateNotificationListQuery({ eventType: 'invalid-lower' }),
      (err: unknown) => err instanceof ApiError && err.statusCode === 400 && err.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => validateNotificationListQuery({ eventType: 'A'.repeat(41) }),
      (err: unknown) => err instanceof ApiError && err.statusCode === 400 && err.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => validateNotificationListQuery({ isRead: 'yes' }),
      (err: unknown) => err instanceof ApiError && err.statusCode === 400 && err.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => validateNotificationListQuery({ page: '1.5' }),
      (err: unknown) => err instanceof ApiError && err.statusCode === 400 && err.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => validateNotificationListQuery({ page: ['1'] }),
      (err: unknown) => err instanceof ApiError && err.statusCode === 400 && err.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => validateNotificationListQuery({ limit: '   ' }),
      (err: unknown) => err instanceof ApiError && err.statusCode === 400 && err.code === 'VALIDATION_ERROR',
    );
  });

  test('validateNotificationListQuery chặn giá trị page vượt giới hạn an toàn (INT4 và Number.MAX_SAFE_INTEGER)', () => {
    assert.deepEqual(validateNotificationListQuery({ page: String(MAX_NOTIFICATION_PAGE), limit: '50' }), {
      page: MAX_NOTIFICATION_PAGE,
      limit: 50,
    });

    const oversizedPages = [
      String(MAX_NOTIFICATION_PAGE + 1),
      '100000000', // 100_000_000 * 50 vượt INT4 OFFSET (2_147_483_647)
      '2147483648', // INT4 max + 1
      String(Number.MAX_SAFE_INTEGER + 1),
      '99999999999999999999999',
    ];

    for (const page of oversizedPages) {
      assert.throws(
        () => validateNotificationListQuery({ page, limit: '50' }),
        (err: unknown) => err instanceof ApiError && err.statusCode === 400 && err.code === 'VALIDATION_ERROR',
      );
    }
  });

  test('mapToNotificationDTO trích xuất payload chuẩn và fallback an toàn với dữ liệu lạ/null', () => {
    const createdAt = new Date('2026-11-22T03:00:00.000Z');
    const dto = mapToNotificationDTO({
      id: '550e8400-e29b-41d4-a716-446655440001',
      recipientId: '550e8400-e29b-41d4-a716-446655440002',
      title: 'Xác nhận tiền cọc',
      eventType: NOTIFICATION_EVENT_TYPE.DEPOSIT_CONFIRMED,
      payload: {
        content: 'Chủ trọ đã xác nhận nhận đủ tiền cọc.',
        actionUrl: '/contracts/123',
        relatedEntityType: 'CONTRACT',
        relatedEntityId: '123',
        metadata: { amount: 3500000 },
      },
      isRead: false,
      createdAt,
    });

    assert.deepEqual(dto, {
      id: '550e8400-e29b-41d4-a716-446655440001',
      eventType: NOTIFICATION_EVENT_TYPE.DEPOSIT_CONFIRMED,
      category: NOTIFICATION_CATEGORY.FINANCE,
      title: 'Xác nhận tiền cọc',
      content: 'Chủ trọ đã xác nhận nhận đủ tiền cọc.',
      actionUrl: '/contracts/123',
      relatedEntityType: 'CONTRACT',
      relatedEntityId: '123',
      payload: {
        content: 'Chủ trọ đã xác nhận nhận đủ tiền cọc.',
        actionUrl: '/contracts/123',
        relatedEntityType: 'CONTRACT',
        relatedEntityId: '123',
        metadata: { amount: 3500000 },
      },
      isRead: false,
      createdAt: '2026-11-22T03:00:00.000Z',
    });

    const fallbackDto = mapToNotificationDTO({
      id: '550e8400-e29b-41d4-a716-446655440003',
      recipientId: '550e8400-e29b-41d4-a716-446655440002',
      title: 'Thông báo hệ thống cũ',
      eventType: 'LEGACY_CUSTOM_EVENT',
      payload: ['unexpected-array'] as unknown as null,
      isRead: true,
      createdAt,
    });

    assert.equal(fallbackDto.category, NOTIFICATION_CATEGORY.SYSTEM);
    assert.equal(fallbackDto.content, null);
    assert.equal(fallbackDto.actionUrl, null);
    assert.equal(fallbackDto.relatedEntityType, null);
    assert.equal(fallbackDto.relatedEntityId, null);
    assert.equal(fallbackDto.payload, null);

    const emptyContentDto = mapToNotificationDTO({
      id: '550e8400-e29b-41d4-a716-446655440004',
      recipientId: '550e8400-e29b-41d4-a716-446655440002',
      title: 'Thông báo nội dung rỗng',
      eventType: NOTIFICATION_EVENT_TYPE.DEPOSIT_CONFIRMED,
      payload: { content: '' },
      isRead: false,
      createdAt,
    });

    assert.equal(emptyContentDto.content, null);
    assert.deepEqual(emptyContentDto.payload, { content: '' });
  });

  test('normalizeNotificationTitle từ chối chuỗi rỗng hoặc chỉ chứa khoảng trắng và createNotification kiểm tra payload JSON an toàn', async () => {
    for (const blank of ['', ' ', '   \t\n  ']) {
      assert.throws(() => normalizeNotificationTitle(blank), /Tiêu đề thông báo không được để trống/);
    }

    let capturedData: any;
    const fakeDb: any = {
      notification: {
        create: async (args: any) => {
          capturedData = args.data;
          return { id: 'n-test', ...args.data };
        },
      },
    };

    const at = new Date('2026-11-22T05:00:00.000Z');
    await createNotification(fakeDb, {
      recipientId: 'user-1',
      title: '  Thông báo có payload hợp lệ  ',
      eventType: NOTIFICATION_EVENT_TYPE.DEPOSIT_CONFIRMED,
      payload: {
        content: 'Nội dung',
        actionUrl: undefined,
        metadata: { amount: 1000, optional: undefined, at: at as unknown as string },
      },
    });

    assert.equal(capturedData.title, 'Thông báo có payload hợp lệ');
    assert.deepEqual(capturedData.payload, {
      content: 'Nội dung',
      metadata: { amount: 1000, at: '2026-11-22T05:00:00.000Z' },
    });

    await assert.rejects(
      () =>
        createNotification(fakeDb, {
          recipientId: 'user-1',
          title: 'Payload lỗi',
          eventType: NOTIFICATION_EVENT_TYPE.DEPOSIT_CONFIRMED,
          payload: { fn: () => {} } as unknown as Record<string, never>,
        }),
      TypeError,
    );

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await assert.rejects(
      () =>
        createNotification(fakeDb, {
          recipientId: 'user-1',
          title: 'Payload vòng lặp',
          eventType: NOTIFICATION_EVENT_TYPE.DEPOSIT_CONFIRMED,
          payload: circular as unknown as Record<string, never>,
        }),
      TypeError,
    );
  });
});
