import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { afterEach, describe, test } from 'node:test';

import { app } from '../../src/app';
import {
  NOTIFICATION_CATEGORY,
  NOTIFICATION_EVENT_TYPE,
} from '../../src/common/constants/phase3-status';
import { ApiError } from '../../src/common/errors/api-error';
import { prisma } from '../../src/infrastructure/database/prisma';
import { signAccessToken } from '../../src/modules/auth/auth.security';
import { NotificationService } from '../../src/modules/notifications/notification.service';

process.env.JWT_SECRET = 'test-secret-must-have-at-least-thirty-two-bytes';

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

async function request(path: string, init: RequestInit = {}) {
  const server = app.listen(0);
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const text = await response.text();
    return { response, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const activeTenant = {
  id: '550e8400-e29b-41d4-a716-446655440001',
  role: 'TENANT',
  accountStatus: 'ACTIVE',
  fullName: 'Tenant Active',
};

const lockedTenant = {
  id: '550e8400-e29b-41d4-a716-446655440002',
  role: 'TENANT',
  accountStatus: 'LOCKED',
  fullName: 'Tenant Locked',
};

function authHeader(userId: string) {
  return { Authorization: `Bearer ${signAccessToken(userId)}` };
}

describe('Notifications HTTP API Routes', () => {
  test('trả 401 UNAUTHORIZED khi thiếu token và 403 ACCOUNT_LOCKED khi tài khoản bị khóa', async () => {
    const unauth = await request('/api/v1/notifications');
    assert.equal(unauth.response.status, 401);
    assert.equal(unauth.body.code, 'UNAUTHORIZED');

    stub(prisma.user, 'findUnique', async () => lockedTenant);
    const locked = await request('/api/v1/notifications', {
      headers: authHeader(lockedTenant.id),
    });
    assert.equal(locked.response.status, 403);
    assert.equal(locked.body.code, 'ACCOUNT_LOCKED');
  });

  test('đặt /unread-count và /read-all trước /:notificationId để không bị nuốt route', async () => {
    stub(prisma.user, 'findUnique', async () => activeTenant);
    stub(NotificationService, 'getUnreadCount', async () => ({ unreadCount: 5 }));
    stub(NotificationService, 'markAllAsRead', async () => ({
      updatedCount: 5,
      unreadCount: 0,
    }));

    const unreadRes = await request('/api/v1/notifications/unread-count', {
      headers: authHeader(activeTenant.id),
    });
    assert.equal(unreadRes.response.status, 200);
    assert.deepEqual(unreadRes.body, { unreadCount: 5 });

    const readAllRes = await request('/api/v1/notifications/read-all', {
      method: 'PATCH',
      headers: authHeader(activeTenant.id),
    });
    assert.equal(readAllRes.response.status, 200);
    assert.deepEqual(readAllRes.body, { updatedCount: 5, unreadCount: 0 });
  });

  test('trả 400 VALIDATION_ERROR khi notificationId sai UUID và 404 khi không thuộc sở hữu', async () => {
    stub(prisma.user, 'findUnique', async () => activeTenant);
    stub(NotificationService, 'getNotificationDetail', async () => {
      throw new ApiError(404, 'NOTIFICATION_NOT_FOUND', 'Thông báo không tồn tại');
    });

    const badId = await request('/api/v1/notifications/not-a-uuid', {
      headers: authHeader(activeTenant.id),
    });
    assert.equal(badId.response.status, 400);
    assert.equal(badId.body.code, 'VALIDATION_ERROR');

    const notOwned = await request(
      '/api/v1/notifications/550e8400-e29b-41d4-a716-446655440099',
      { headers: authHeader(activeTenant.id) },
    );
    assert.equal(notOwned.response.status, 404);
    assert.equal(notOwned.body.code, 'NOTIFICATION_NOT_FOUND');

    const badPatchId = await request('/api/v1/notifications/not-a-uuid/read', {
      method: 'PATCH',
      headers: authHeader(activeTenant.id),
    });
    assert.equal(badPatchId.response.status, 400);
    assert.equal(badPatchId.body.code, 'VALIDATION_ERROR');

    const overLimit = await request('/api/v1/notifications?limit=100', {
      headers: authHeader(activeTenant.id),
    });
    assert.equal(overLimit.response.status, 400);
    assert.equal(overLimit.body.code, 'VALIDATION_ERROR');
  });

  test('GET /notifications, GET /:notificationId và PATCH /:notificationId/read trả đúng DTO phẳng', async () => {
    const notifId = '550e8400-e29b-41d4-a716-446655440030';
    const flatItem = {
      id: notifId,
      eventType: NOTIFICATION_EVENT_TYPE.DEPOSIT_CONFIRMED,
      category: NOTIFICATION_CATEGORY.FINANCE,
      title: 'Đã xác nhận tiền cọc',
      content: 'Chủ trọ đã xác nhận nhận đủ tiền cọc.',
      actionUrl: '/contracts/c1',
      relatedEntityType: 'CONTRACT',
      relatedEntityId: 'c1',
      payload: { content: 'Chủ trọ đã xác nhận nhận đủ tiền cọc.' },
      isRead: true,
      createdAt: '2026-11-22T03:00:00.000Z',
    };

    stub(prisma.user, 'findUnique', async () => activeTenant);
    stub(NotificationService, 'getNotifications', async () => ({
      items: [flatItem],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
      unreadCount: 0,
    }));
    stub(NotificationService, 'getNotificationDetail', async () => ({
      ...flatItem,
      unreadCount: 0,
    }));
    stub(NotificationService, 'markAsRead', async () => ({
      ...flatItem,
      unreadCount: 0,
    }));

    const listRes = await request('/api/v1/notifications?category=FINANCE&isRead=true', {
      headers: authHeader(activeTenant.id),
    });
    assert.equal(listRes.response.status, 200);
    assert.equal(listRes.body.items.length, 1);
    assert.equal(listRes.body.total, 1);
    assert.equal(listRes.body.limit, 20);

    const detailRes = await request(`/api/v1/notifications/${notifId}`, {
      headers: authHeader(activeTenant.id),
    });
    assert.equal(detailRes.response.status, 200);
    assert.equal(detailRes.body.id, notifId);
    assert.equal(detailRes.body.isRead, true);
    assert.equal(detailRes.body.unreadCount, 0);

    const markRes = await request(`/api/v1/notifications/${notifId}/read`, {
      method: 'PATCH',
      headers: authHeader(activeTenant.id),
    });
    assert.equal(markRes.response.status, 200);
    assert.equal(markRes.body.id, notifId);
    assert.equal(markRes.body.isRead, true);
    assert.equal(markRes.body.unreadCount, 0);
  });
});
