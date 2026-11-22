import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ApiError } from '../../src/common/errors/api-error';
import {
  NOTIFICATION_CATEGORY,
  NOTIFICATION_EVENT_TYPE,
} from '../../src/common/constants/phase3-status';
import { mapToNotificationDTO } from '../../src/modules/notifications/notification.mapper';
import {
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
  });
});
