import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { app } from '../../src/app';
import {
  NOTIFICATION_CATEGORY,
  NOTIFICATION_EVENT_TYPE,
} from '../../src/common/constants/phase3-status';
import { createNotification } from '../../src/common/utils/notification.util';
import { prisma } from '../../src/infrastructure/database/prisma';
import { signAccessToken } from '../../src/modules/auth/auth.security';

process.env.JWT_SECRET = 'test-secret-must-have-at-least-thirty-two-bytes';

async function apiRequest(path: string, token: string, init: RequestInit = {}) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    return { response, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test('Live DB: Notifications CRUD, filtering, Anti-IDOR, idempotent mark-read & Viewing hooks', async (t) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    t.skip('PostgreSQL is not available');
    return;
  }

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const userIds: string[] = [];
  let propertyId: string | undefined;
  let roomId: string | undefined;
  const appointmentIds: string[] = [];

  try {
    const landlord = await prisma.user.create({
      data: {
        fullName: 'Notif Landlord',
        email: `notif-owner-${suffix}@rentmate.test`,
        phone: `09${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`,
        passwordHash: 'test-only',
        role: 'LANDLORD',
        accountStatus: 'ACTIVE',
      },
    });
    userIds.push(landlord.id);

    const tenantA = await prisma.user.create({
      data: {
        fullName: 'Notif Tenant A',
        email: `notif-a-${suffix}@rentmate.test`,
        phone: `09${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`,
        passwordHash: 'test-only',
        role: 'TENANT',
        accountStatus: 'ACTIVE',
      },
    });
    userIds.push(tenantA.id);

    const tenantB = await prisma.user.create({
      data: {
        fullName: 'Notif Tenant B',
        email: `notif-b-${suffix}@rentmate.test`,
        phone: `09${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`,
        passwordHash: 'test-only',
        role: 'TENANT',
        accountStatus: 'ACTIVE',
      },
    });
    userIds.push(tenantB.id);

    const tokenLandlord = signAccessToken(landlord.id);
    const tokenA = signAccessToken(tenantA.id);
    const tokenB = signAccessToken(tenantB.id);

    // 1. Tạo thông báo đa danh mục cho tenantA và tenantB
    const nFinance = await createNotification(prisma, {
      recipientId: tenantA.id,
      title: 'Biên nhận cọc đã được duyệt',
      eventType: NOTIFICATION_EVENT_TYPE.DEPOSIT_CONFIRMED,
      payload: {
        content: 'Chủ trọ đã xác nhận tiền cọc.',
        actionUrl: '/contracts/c1',
        relatedEntityType: 'CONTRACT',
        relatedEntityId: 'c1',
      },
    });
    const nRepair = await createNotification(prisma, {
      recipientId: tenantA.id,
      title: 'Sự cố đang được xử lý',
      eventType: NOTIFICATION_EVENT_TYPE.REPAIR_TICKET_ACCEPTED,
      payload: {
        content: 'Thợ sửa sẽ đến vào ngày mai.',
        actionUrl: '/repairs/r1',
        relatedEntityType: 'REPAIR_TICKET',
        relatedEntityId: 'r1',
      },
    });
    const nSystem = await createNotification(prisma, {
      recipientId: tenantA.id,
      title: 'Thông báo hệ thống tương lai',
      eventType: 'CUSTOM_SYSTEM_NOTICE',
      payload: { content: 'Bảo trì hệ thống.' },
    });
    await createNotification(prisma, {
      recipientId: tenantB.id,
      title: 'Thông báo riêng của Tenant B',
      eventType: NOTIFICATION_EVENT_TYPE.DEPOSIT_REJECTED,
      payload: { content: 'Biên lai bị từ chối.' },
    });

    // 2. Kiểm tra unread-count và danh sách có lọc category / cross-filter
    const unreadARes = await apiRequest('/api/v1/notifications/unread-count', tokenA);
    assert.equal(unreadARes.response.status, 200);
    assert.equal(unreadARes.body.unreadCount, 3);

    const financeList = await apiRequest('/api/v1/notifications?category=FINANCE', tokenA);
    assert.equal(financeList.response.status, 200);
    assert.equal(financeList.body.total, 1);
    assert.equal(financeList.body.items[0].id, nFinance.id);
    assert.equal(financeList.body.items[0].content, 'Chủ trọ đã xác nhận tiền cọc.');
    assert.equal(financeList.body.unreadCount, 3);

    const systemList = await apiRequest('/api/v1/notifications?category=SYSTEM', tokenA);
    assert.equal(systemList.response.status, 200);
    assert.equal(systemList.body.total, 1);
    assert.equal(systemList.body.items[0].id, nSystem.id);

    const mismatchList = await apiRequest(
      `/api/v1/notifications?category=FINANCE&eventType=${NOTIFICATION_EVENT_TYPE.REPAIR_TICKET_ACCEPTED}`,
      tokenA,
    );
    assert.equal(mismatchList.response.status, 200);
    assert.equal(mismatchList.body.total, 0);

    // 3. Anti-IDOR: Tenant B truy cập / đọc thông báo của Tenant A phải trả 404 và không sửa isRead
    const idorDetail = await apiRequest(`/api/v1/notifications/${nFinance.id}`, tokenB);
    assert.equal(idorDetail.response.status, 404);
    assert.equal(idorDetail.body.code, 'NOTIFICATION_NOT_FOUND');

    const idorRead = await apiRequest(`/api/v1/notifications/${nFinance.id}/read`, tokenB, {
      method: 'PATCH',
    });
    assert.equal(idorRead.response.status, 404);
    const nFinanceCheck = await prisma.notification.findUnique({ where: { id: nFinance.id } });
    assert.equal(nFinanceCheck?.isRead, false);

    // 4. GET /:id tự động chuyển isRead = true (idempotent) và giảm unreadCount
    const detail1 = await apiRequest(`/api/v1/notifications/${nFinance.id}`, tokenA);
    assert.equal(detail1.response.status, 200);
    assert.equal(detail1.body.id, nFinance.id);
    assert.equal(detail1.body.category, NOTIFICATION_CATEGORY.FINANCE);
    assert.equal(detail1.body.isRead, true);
    assert.equal(detail1.body.unreadCount, 2);

    const detail2 = await apiRequest(`/api/v1/notifications/${nFinance.id}`, tokenA);
    assert.equal(detail2.response.status, 200);
    assert.equal(detail2.body.isRead, true);
    assert.equal(detail2.body.unreadCount, 2);

    // 5. PATCH /:id/read hoạt động và idempotent
    const patchRead = await apiRequest(`/api/v1/notifications/${nRepair.id}/read`, tokenA, {
      method: 'PATCH',
    });
    assert.equal(patchRead.response.status, 200);
    assert.equal(patchRead.body.isRead, true);
    assert.equal(patchRead.body.unreadCount, 1);

    // 6. PATCH /read-all chỉ tác động lên Tenant A, không đụng Tenant B
    const readAllA = await apiRequest('/api/v1/notifications/read-all', tokenA, {
      method: 'PATCH',
    });
    assert.equal(readAllA.response.status, 200);
    assert.deepEqual(readAllA.body, { updatedCount: 1, unreadCount: 0 });

    const unreadBRes = await apiRequest('/api/v1/notifications/unread-count', tokenB);
    assert.equal(unreadBRes.response.status, 200);
    assert.equal(unreadBRes.body.unreadCount, 1);

    // 7. End-to-End Viewing Appointment -> Notification hooks
    const property = await prisma.property.create({
      data: {
        landlordId: landlord.id,
        name: `Notif Property ${suffix}`,
        address: 'Thủ Đức',
        status: 'ACTIVE',
      },
    });
    propertyId = property.id;

    const room = await prisma.room.create({
      data: {
        propertyId,
        roomCode: `NF-${suffix}`,
        areaM2: 20,
        maxOccupants: 2,
        monthlyRent: 3000000,
        depositRequired: 3000000,
        electricityRate: 3500,
        waterRate: 15000,
        occupancyStatus: 'VACANT',
        visibilityStatus: 'VISIBLE',
      },
    });
    roomId = room.id;

    const futureSlot1 = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const futureSlot2 = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    // 7a. Tenant A đặt lịch -> Landlord nhận VIEWING_APPOINTMENT_CREATED
    const createViewRes = await apiRequest('/api/v1/viewing-appointments', tokenA, {
      method: 'POST',
      body: JSON.stringify({
        roomId,
        proposedSlots: [futureSlot1],
      }),
    });
    assert.equal(createViewRes.response.status, 201);
    const appt1Id = createViewRes.body.appointmentId as string;
    appointmentIds.push(appt1Id);

    const landlordNotifs = await apiRequest('/api/v1/notifications', tokenLandlord);
    assert.equal(landlordNotifs.response.status, 200);
    assert.equal(landlordNotifs.body.items[0].eventType, NOTIFICATION_EVENT_TYPE.VIEWING_APPOINTMENT_CREATED);
    assert.equal(landlordNotifs.body.items[0].relatedEntityId, appt1Id);

    // 7b. Landlord xác nhận lịch -> Tenant A nhận VIEWING_APPOINTMENT_CONFIRMED
    const appt1Detail = await apiRequest(`/api/v1/viewing-appointments/${appt1Id}`, tokenLandlord);
    const slot1Id = appt1Detail.body.proposedSlots[0].id as string;

    const confirmRes = await apiRequest(
      `/api/v1/viewing-appointments/${appt1Id}/confirm`,
      tokenLandlord,
      { method: 'PATCH', body: JSON.stringify({ selectedSlotId: slot1Id }) },
    );
    assert.equal(confirmRes.response.status, 200);

    const tenantANotifsAfterConfirm = await apiRequest('/api/v1/notifications', tokenA);
    assert.equal(
      tenantANotifsAfterConfirm.body.items[0].eventType,
      NOTIFICATION_EVENT_TYPE.VIEWING_APPOINTMENT_CONFIRMED,
    );

    // 7c. Tenant A hủy lịch -> Landlord nhận VIEWING_APPOINTMENT_CANCELLED
    const cancelRes = await apiRequest(`/api/v1/viewing-appointments/${appt1Id}/cancel`, tokenA, {
      method: 'PATCH',
      body: JSON.stringify({ reason: 'Bận đột xuất' }),
    });
    assert.equal(cancelRes.response.status, 200);

    const landlordNotifsAfterCancel = await apiRequest('/api/v1/notifications', tokenLandlord);
    assert.equal(
      landlordNotifsAfterCancel.body.items[0].eventType,
      NOTIFICATION_EVENT_TYPE.VIEWING_APPOINTMENT_CANCELLED,
    );

    // 7d. Tenant B đặt lịch mới -> Landlord từ chối -> Tenant B nhận VIEWING_APPOINTMENT_REJECTED
    const createView2Res = await apiRequest('/api/v1/viewing-appointments', tokenB, {
      method: 'POST',
      body: JSON.stringify({
        roomId,
        proposedSlots: [futureSlot2],
      }),
    });
    assert.equal(createView2Res.response.status, 201);
    const appt2Id = createView2Res.body.appointmentId as string;
    appointmentIds.push(appt2Id);

    const rejectRes = await apiRequest(
      `/api/v1/viewing-appointments/${appt2Id}/reject`,
      tokenLandlord,
      { method: 'PATCH', body: JSON.stringify({ reason: 'Trùng lịch công tác' }) },
    );
    assert.equal(rejectRes.response.status, 200);

    const tenantBNotifs = await apiRequest('/api/v1/notifications', tokenB);
    assert.equal(
      tenantBNotifs.body.items[0].eventType,
      NOTIFICATION_EVENT_TYPE.VIEWING_APPOINTMENT_REJECTED,
    );
  } finally {
    if (appointmentIds.length > 0) {
      await prisma.viewingAppointment
        .deleteMany({ where: { id: { in: appointmentIds } } })
        .catch(() => {});
    }
    if (roomId) {
      await prisma.room.delete({ where: { id: roomId } }).catch(() => {});
    }
    if (propertyId) {
      await prisma.property.delete({ where: { id: propertyId } }).catch(() => {});
    }
    if (userIds.length > 0) {
      await prisma.notification
        .deleteMany({ where: { recipientId: { in: userIds } } })
        .catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    }
  }
});
