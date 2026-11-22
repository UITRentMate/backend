import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { app } from '../../src/app';
import {
  CONTRACT_STATUS,
  NOTIFICATION_EVENT_TYPE,
  RESIDENT_INVITATION_STATUS,
} from '../../src/common/constants/phase3-status';
import { prisma } from '../../src/infrastructure/database/prisma';
import { signAccessToken } from '../../src/modules/auth/auth.security';

process.env.JWT_SECRET = 'test-secret-must-have-at-least-thirty-two-bytes';

function assertStandardNotificationPayload(
  payload: unknown,
  expectedRelatedEntityType: 'RESIDENT_INVITATION' | 'CONTRACT',
  expectedRelatedEntityId: string,
  expectedActionUrl: string,
) {
  assert.ok(payload && typeof payload === 'object');
  const record = payload as Record<string, unknown>;
  assert.equal(typeof record.content, 'string');
  assert.ok((record.content as string).length > 0);
  assert.equal(record.actionUrl, expectedActionUrl);
  assert.equal(record.relatedEntityType, expectedRelatedEntityType);
  assert.equal(record.relatedEntityId, expectedRelatedEntityId);
  assert.ok(record.metadata && typeof record.metadata === 'object');
}

describe('Resident PostgreSQL Live DB Integration Tests', () => {
  let dbReady = true;
  let server: http.Server;
  let baseUrl = '';

  const createdUserIds: string[] = [];
  const createdPropertyIds: string[] = [];
  const createdRoomIds: string[] = [];
  const createdContractIds: string[] = [];

  const uniqueBase = Date.now() % 10_000_000;
  let phoneSeq = 0;
  function nextPhone(): string {
    phoneSeq += 1;
    return `09${String(uniqueBase).padStart(7, '0').slice(-6)}${String(phoneSeq).padStart(2, '0')}`;
  }

  async function createTestUser(role: 'TENANT' | 'LANDLORD', label: string) {
    const idx = createdUserIds.length + 1;
    const user = await prisma.user.create({
      data: {
        fullName: `${label} ${idx}`,
        email: `res-int-${uniqueBase}-${idx}-${Math.random().toString(36).slice(2, 7)}@rentmate.test`,
        phone: nextPhone(),
        passwordHash: 'test-only-hash',
        role,
        accountStatus: 'ACTIVE',
      },
    });
    createdUserIds.push(user.id);
    return user;
  }

  async function createTestContract(params: {
    landlordId: string;
    primaryTenantId: string;
    maxOccupants: number;
    status?: string;
    roomCode?: string;
  }) {
    const property = await prisma.property.create({
      data: {
        landlordId: params.landlordId,
        name: `Resident Test Property ${uniqueBase}-${createdPropertyIds.length + 1}`,
        address: '123 Test Street, Thu Duc',
        status: 'ACTIVE',
      },
    });
    createdPropertyIds.push(property.id);

    const room = await prisma.room.create({
      data: {
        propertyId: property.id,
        roomCode: params.roomCode ?? `P.${createdRoomIds.length + 101}`,
        areaM2: 24,
        maxOccupants: params.maxOccupants,
        monthlyRent: 3500000,
        depositRequired: 3500000,
        electricityRate: 3500,
        waterRate: 20000,
        occupancyStatus: 'OCCUPIED',
        visibilityStatus: 'VISIBLE',
      },
    });
    createdRoomIds.push(room.id);

    const contract = await prisma.contract.create({
      data: {
        roomId: room.id,
        tenantId: params.primaryTenantId,
        startDate: new Date('2026-11-01'),
        endDate: new Date('2027-11-01'),
        status: params.status ?? CONTRACT_STATUS.ACTIVE,
        rentSnapshot: 3500000,
        depositSnapshot: 3500000,
        electricityRate: 3500,
        waterRate: 20000,
        activatedAt: new Date('2026-11-01T08:00:00.000Z'),
      },
    });
    createdContractIds.push(contract.id);
    return { property, room, contract };
  }

  async function apiCall(
    method: string,
    path: string,
    userId: string,
    body?: Record<string, unknown>,
  ) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${signAccessToken(userId)}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await response.json()) as Record<string, any>;
    return { status: response.status, body: json };
  }

  before(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbReady = false;
      return;
    }

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    if (!dbReady) return;

    const invitationIds =
      createdContractIds.length > 0
        ? (
            await prisma.residentInvitation.findMany({
              where: { contractId: { in: createdContractIds } },
              select: { id: true },
            })
          ).map((item) => item.id)
        : [];

    const auditEntityIds = [...createdContractIds, ...invitationIds];
    if (auditEntityIds.length > 0) {
      await prisma.auditLog.deleteMany({
        where: { entityId: { in: auditEntityIds } },
      });
    }
    if (createdUserIds.length > 0) {
      await prisma.notification.deleteMany({
        where: { recipientId: { in: createdUserIds } },
      });
    }
    if (createdContractIds.length > 0) {
      await prisma.residentInvitation.deleteMany({
        where: { contractId: { in: createdContractIds } },
      });
      await prisma.contractResident.deleteMany({
        where: { contractId: { in: createdContractIds } },
      });
      await prisma.contract.deleteMany({
        where: { id: { in: createdContractIds } },
      });
    }
    if (createdRoomIds.length > 0) {
      await prisma.room.deleteMany({
        where: { id: { in: createdRoomIds } },
      });
    }
    if (createdPropertyIds.length > 0) {
      await prisma.property.deleteMany({
        where: { id: { in: createdPropertyIds } },
      });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }
  });

  test('1. Concurrency /accept (BR-11): 2 lời mời cùng chấp nhận vào phòng maxOccupants=2 trả [200, 409 ROOM_CAPACITY_EXCEEDED]', async (t) => {
    if (!dbReady) {
      t.skip('PostgreSQL is not available');
      return;
    }

    const landlord = await createTestUser('LANDLORD', 'Landlord C1');
    const primary = await createTestUser('TENANT', 'Primary C1');
    const inviteeB = await createTestUser('TENANT', 'Invitee B1');
    const inviteeC = await createTestUser('TENANT', 'Invitee C1');

    const { contract, room } = await createTestContract({
      landlordId: landlord.id,
      primaryTenantId: primary.id,
      maxOccupants: 2,
      roomCode: 'P.201',
    });

    const invB = await apiCall('POST', `/api/v1/contracts/${contract.id}/invitations`, primary.id, {
      identifier: inviteeB.email,
    });
    const invC = await apiCall('POST', `/api/v1/contracts/${contract.id}/invitations`, primary.id, {
      identifier: inviteeC.phone,
    });
    assert.equal(invB.status, 201);
    assert.equal(invC.status, 201);

    const results = await Promise.all([
      apiCall('PATCH', `/api/v1/resident-invitations/${invB.body.invitationId}/accept`, inviteeB.id),
      apiCall('PATCH', `/api/v1/resident-invitations/${invC.body.invitationId}/accept`, inviteeC.id),
    ]);

    const sortedStatuses = results.map((r) => r.status).sort();
    assert.deepEqual(sortedStatuses, [200, 409]);

    const failed = results.find((r) => r.status === 409)!;
    assert.equal(failed.body.code, 'ROOM_CAPACITY_EXCEEDED');

    const activeResidents = await prisma.contractResident.findMany({
      where: { contractId: contract.id, leftAt: null },
    });
    assert.equal(activeResidents.length, 1);

    const detail = await apiCall('GET', `/api/v1/contracts/${contract.id}/residents`, primary.id);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.currentOccupants, 2);
    assert.equal(detail.body.maxOccupants, 2);
    assert.equal(detail.body.remainingSlots, 0);
    assert.equal(detail.body.residents.length, 2);
    assert.equal(detail.body.residents[0].residentRole, 'PRIMARY_TENANT');
    assert.equal(detail.body.residents[1].residentRole, 'CO_RESIDENT');

    const joinedNotifs = await prisma.notification.findMany({
      where: {
        recipientId: { in: [primary.id, landlord.id] },
        eventType: NOTIFICATION_EVENT_TYPE.RESIDENT_JOINED,
      },
    });
    assert.equal(joinedNotifs.length, 2);
    for (const notif of joinedNotifs) {
      const expectedUrl =
        notif.recipientId === landlord.id
          ? `/landlord/contracts/${contract.id}/residents`
          : `/contracts/${contract.id}/residents`;
      assertStandardNotificationPayload(notif.payload, 'CONTRACT', contract.id, expectedUrl);
    }

    const acceptedInvitationId = results.find((r) => r.status === 200)!.body.invitationId as string;
    const acceptAudit = await prisma.auditLog.findMany({
      where: {
        entityType: 'RESIDENT_INVITATION',
        entityId: acceptedInvitationId,
        action: 'RESIDENT_INVITATION_ACCEPTED',
      },
    });
    assert.equal(acceptAudit.length, 1);
    assert.equal(room.maxOccupants, 2);
  });

  test('2. Concurrency POST /invitations: Chủ HĐ và Chủ trọ mời cùng 1 người song song trả [201, 409 INVITATION_ALREADY_PENDING]', async (t) => {
    if (!dbReady) {
      t.skip('PostgreSQL is not available');
      return;
    }

    const landlord = await createTestUser('LANDLORD', 'Landlord C2');
    const primary = await createTestUser('TENANT', 'Primary C2');
    const invitee = await createTestUser('TENANT', 'Invitee C2');
    const { contract } = await createTestContract({
      landlordId: landlord.id,
      primaryTenantId: primary.id,
      maxOccupants: 3,
      roomCode: 'P.202',
    });

    const results = await Promise.all([
      apiCall('POST', `/api/v1/contracts/${contract.id}/invitations`, primary.id, {
        identifier: invitee.email,
      }),
      apiCall('POST', `/api/v1/contracts/${contract.id}/invitations`, landlord.id, {
        identifier: invitee.email,
      }),
    ]);

    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(
      results.find((r) => r.status === 409)!.body.code,
      'INVITATION_ALREADY_PENDING',
    );

    const pendingCount = await prisma.residentInvitation.count({
      where: {
        contractId: contract.id,
        invitedUserId: invitee.id,
        status: RESIDENT_INVITATION_STATUS.PENDING,
      },
    });
    assert.equal(pendingCount, 1);
  });

  test('3. Composite PK Upsert (Rejoin flow): Gỡ người ở cùng rồi mời lại và /accept thành công không lỗi PK', async (t) => {
    if (!dbReady) {
      t.skip('PostgreSQL is not available');
      return;
    }

    const landlord = await createTestUser('LANDLORD', 'Landlord C3');
    const primary = await createTestUser('TENANT', 'Primary C3');
    const tenantB = await createTestUser('TENANT', 'Tenant B3');
    const { contract } = await createTestContract({
      landlordId: landlord.id,
      primaryTenantId: primary.id,
      maxOccupants: 3,
      roomCode: 'P.203',
    });

    const inv1 = await apiCall('POST', `/api/v1/contracts/${contract.id}/invitations`, primary.id, {
      identifier: tenantB.email,
    });
    assert.equal(inv1.status, 201);
    const acc1 = await apiCall(
      'PATCH',
      `/api/v1/resident-invitations/${inv1.body.invitationId}/accept`,
      tenantB.id,
    );
    assert.equal(acc1.status, 200);

    const removed = await apiCall(
      'DELETE',
      `/api/v1/contracts/${contract.id}/residents/${tenantB.id}`,
      primary.id,
    );
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removalType, 'REMOVED_BY_PRIMARY_TENANT');

    const rowAfterLeave = await prisma.contractResident.findUnique({
      where: { contractId_userId: { contractId: contract.id, userId: tenantB.id } },
    });
    assert.ok(rowAfterLeave?.leftAt !== null);

    const inv2 = await apiCall('POST', `/api/v1/contracts/${contract.id}/invitations`, landlord.id, {
      identifier: tenantB.phone,
    });
    assert.equal(inv2.status, 201);

    const acc2 = await apiCall(
      'PATCH',
      `/api/v1/resident-invitations/${inv2.body.invitationId}/accept`,
      tenantB.id,
    );
    assert.equal(acc2.status, 200);
    assert.equal(acc2.body.currentOccupants, 2);

    const rowAfterRejoin = await prisma.contractResident.findUnique({
      where: { contractId_userId: { contractId: contract.id, userId: tenantB.id } },
    });
    assert.equal(rowAfterRejoin?.leftAt, null);
  });

  test('4. Lazy Expiration Persistence: Hết hạn trả 409 INVITATION_EXPIRED và commit EXPIRED xuống PostgreSQL (không rollback)', async (t) => {
    if (!dbReady) {
      t.skip('PostgreSQL is not available');
      return;
    }

    const landlord = await createTestUser('LANDLORD', 'Landlord C4');
    const primary = await createTestUser('TENANT', 'Primary C4');
    const invitee = await createTestUser('TENANT', 'Invitee C4');
    const { contract } = await createTestContract({
      landlordId: landlord.id,
      primaryTenantId: primary.id,
      maxOccupants: 3,
      roomCode: 'P.204',
    });

    const past = new Date(Date.now() - 60_000);
    const expiredForAccept = await prisma.residentInvitation.create({
      data: {
        contractId: contract.id,
        invitedUserId: invitee.id,
        invitedById: primary.id,
        status: RESIDENT_INVITATION_STATUS.PENDING,
        expiresAt: past,
      },
    });
    const expiredForReject = await prisma.residentInvitation.create({
      data: {
        contractId: contract.id,
        invitedUserId: invitee.id,
        invitedById: primary.id,
        status: RESIDENT_INVITATION_STATUS.PENDING,
        expiresAt: past,
      },
    });
    const expiredForCancel = await prisma.residentInvitation.create({
      data: {
        contractId: contract.id,
        invitedUserId: invitee.id,
        invitedById: primary.id,
        status: RESIDENT_INVITATION_STATUS.PENDING,
        expiresAt: past,
      },
    });

    const acceptRes = await apiCall(
      'PATCH',
      `/api/v1/resident-invitations/${expiredForAccept.id}/accept`,
      invitee.id,
    );
    assert.equal(acceptRes.status, 409);
    assert.equal(acceptRes.body.code, 'INVITATION_EXPIRED');

    const rejectRes = await apiCall(
      'PATCH',
      `/api/v1/resident-invitations/${expiredForReject.id}/reject`,
      invitee.id,
    );
    assert.equal(rejectRes.status, 409);
    assert.equal(rejectRes.body.code, 'INVITATION_EXPIRED');

    const cancelRes = await apiCall(
      'PATCH',
      `/api/v1/resident-invitations/${expiredForCancel.id}/cancel`,
      primary.id,
    );
    assert.equal(cancelRes.status, 409);
    assert.equal(cancelRes.body.code, 'INVITATION_EXPIRED');

    const dbRows = await prisma.residentInvitation.findMany({
      where: { id: { in: [expiredForAccept.id, expiredForReject.id, expiredForCancel.id] } },
    });
    assert.equal(dbRows.length, 3);
    for (const row of dbRows) {
      assert.equal(row.status, RESIDENT_INVITATION_STATUS.EXPIRED);
    }

    const reinvite = await apiCall('POST', `/api/v1/contracts/${contract.id}/invitations`, primary.id, {
      identifier: invitee.email,
    });
    assert.equal(reinvite.status, 201);

    const pendingInbox = await apiCall('GET', '/api/v1/resident-invitations?status=PENDING', invitee.id);
    assert.equal(pendingInbox.status, 200);
    assert.equal(pendingInbox.body.total, 1);
    assert.equal(pendingInbox.body.items[0].invitationId, reinvite.body.invitationId);

    const expiredInbox = await apiCall('GET', '/api/v1/resident-invitations?status=EXPIRED', invitee.id);
    assert.equal(expiredInbox.status, 200);
    assert.equal(expiredInbox.body.total, 3);
  });

  test('5. BR-10, Self-leave, Anti-IDOR, 5 Notification Events, AuditLog & Non-ACTIVE Contract', async (t) => {
    if (!dbReady) {
      t.skip('PostgreSQL is not available');
      return;
    }

    const landlord = await createTestUser('LANDLORD', 'Landlord C5');
    const primary = await createTestUser('TENANT', 'Primary C5');
    const coRes1 = await createTestUser('TENANT', 'CoRes1 C5');
    const coRes2 = await createTestUser('TENANT', 'CoRes2 C5');
    const outsider = await createTestUser('TENANT', 'Outsider C5');

    const { contract } = await createTestContract({
      landlordId: landlord.id,
      primaryTenantId: primary.id,
      maxOccupants: 4,
      roomCode: 'P.205',
    });

    // Invite & accept coRes1 and coRes2
    const inv1 = await apiCall('POST', `/api/v1/contracts/${contract.id}/invitations`, primary.id, {
      identifier: coRes1.email,
    });
    assert.equal(inv1.status, 201);
    assert.equal(
      (await apiCall('PATCH', `/api/v1/resident-invitations/${inv1.body.invitationId}/accept`, coRes1.id)).status,
      200,
    );

    const inv2 = await apiCall('POST', `/api/v1/contracts/${contract.id}/invitations`, landlord.id, {
      identifier: coRes2.email,
    });
    assert.equal(inv2.status, 201);
    assert.equal(
      (await apiCall('PATCH', `/api/v1/resident-invitations/${inv2.body.invitationId}/accept`, coRes2.id)).status,
      200,
    );

    // Cannot remove primary tenant (BR-10)
    const rmPrimary = await apiCall(
      'DELETE',
      `/api/v1/contracts/${contract.id}/residents/${primary.id}`,
      landlord.id,
    );
    assert.equal(rmPrimary.status, 400);
    assert.equal(rmPrimary.body.code, 'CANNOT_REMOVE_PRIMARY_TENANT');

    // CO_RESIDENT view has pendingInvitations === null, cannot invite (403), cannot remove another resident (403)
    const coResView = await apiCall('GET', `/api/v1/contracts/${contract.id}/residents`, coRes1.id);
    assert.equal(coResView.status, 200);
    assert.equal(coResView.body.pendingInvitations, null);

    const coResInvite = await apiCall(
      'POST',
      `/api/v1/contracts/${contract.id}/invitations`,
      coRes1.id,
      { identifier: outsider.email },
    );
    assert.equal(coResInvite.status, 403);

    const coResRemoveOther = await apiCall(
      'DELETE',
      `/api/v1/contracts/${contract.id}/residents/${coRes2.id}`,
      coRes1.id,
    );
    assert.equal(coResRemoveOther.status, 403);

    // Outsider receives 404 Anti-IDOR
    assert.equal(
      (await apiCall('GET', `/api/v1/contracts/${contract.id}/residents`, outsider.id)).status,
      404,
    );

    // CO_RESIDENT self-leave -> 200 + 3 Notifications (Landlord, Primary, Self) + AuditLog
    const selfLeave = await apiCall(
      'DELETE',
      `/api/v1/contracts/${contract.id}/residents/${coRes1.id}`,
      coRes1.id,
    );
    assert.equal(selfLeave.status, 200);
    assert.equal(selfLeave.body.removalType, 'SELF_LEAVE');
    assert.equal(selfLeave.body.currentOccupants, 2);

    const removedNotifs = await prisma.notification.findMany({
      where: {
        recipientId: { in: [landlord.id, primary.id, coRes1.id] },
        eventType: NOTIFICATION_EVENT_TYPE.RESIDENT_REMOVED,
      },
    });
    assert.equal(removedNotifs.length, 3);
    for (const notif of removedNotifs) {
      const expectedUrl =
        notif.recipientId === landlord.id
          ? `/landlord/contracts/${contract.id}/residents`
          : notif.recipientId === primary.id
            ? `/contracts/${contract.id}/residents`
            : '/contracts';
      assertStandardNotificationPayload(notif.payload, 'CONTRACT', contract.id, expectedUrl);
    }

    const selfLeaveAudit = await prisma.auditLog.findFirst({
      where: {
        entityType: 'CONTRACT_RESIDENT',
        entityId: contract.id,
        action: 'RESIDENT_SELF_LEFT',
      },
    });
    assert.ok(selfLeaveAudit);

    // Former Co-Resident loses access -> 404 CONTRACT_NOT_FOUND
    const formerResView = await apiCall('GET', `/api/v1/contracts/${contract.id}/residents`, coRes1.id);
    assert.equal(formerResView.status, 404);
    assert.equal(formerResView.body.code, 'CONTRACT_NOT_FOUND');

    // Reject & Cancel notifications & audit logs (invitedById only for REJECTED)
    const invReject = await apiCall(
      'POST',
      `/api/v1/contracts/${contract.id}/invitations`,
      landlord.id,
      { identifier: outsider.email },
    );
    assert.equal(invReject.status, 201);
    const rejected = await apiCall(
      'PATCH',
      `/api/v1/resident-invitations/${invReject.body.invitationId}/reject`,
      outsider.id,
    );
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.status, 'REJECTED');

    const rejectNotifs = await prisma.notification.findMany({
      where: {
        eventType: NOTIFICATION_EVENT_TYPE.RESIDENT_INVITATION_REJECTED,
        recipientId: { in: [landlord.id, primary.id, outsider.id] },
      },
    });
    assert.equal(rejectNotifs.length, 1);
    assert.equal(rejectNotifs[0].recipientId, landlord.id);
    assertStandardNotificationPayload(
      rejectNotifs[0].payload,
      'RESIDENT_INVITATION',
      invReject.body.invitationId,
      `/landlord/contracts/${contract.id}/residents`,
    );

    const invCancel = await apiCall(
      'POST',
      `/api/v1/contracts/${contract.id}/invitations`,
      primary.id,
      { identifier: coRes1.email },
    );
    assert.equal(invCancel.status, 201);
    const cancelled = await apiCall(
      'PATCH',
      `/api/v1/resident-invitations/${invCancel.body.invitationId}/cancel`,
      primary.id,
    );
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, 'CANCELLED');

    const cancelNotifs = await prisma.notification.findMany({
      where: {
        recipientId: coRes1.id,
        eventType: NOTIFICATION_EVENT_TYPE.RESIDENT_INVITATION_CANCELLED,
      },
    });
    assert.equal(cancelNotifs.length, 1);
    assertStandardNotificationPayload(
      cancelNotifs[0].payload,
      'RESIDENT_INVITATION',
      invCancel.body.invitationId,
      '/resident-invitations',
    );

    // Non-ACTIVE contract (LIQUIDATING): allow GET, PATCH /reject, PATCH /cancel; block POST, /accept, DELETE with 409
    const invForLiquidatingAccept = await apiCall(
      'POST',
      `/api/v1/contracts/${contract.id}/invitations`,
      primary.id,
      { identifier: outsider.email },
    );
    const invForLiquidatingReject = await apiCall(
      'POST',
      `/api/v1/contracts/${contract.id}/invitations`,
      primary.id,
      { identifier: coRes1.email },
    );
    assert.equal(invForLiquidatingAccept.status, 201);
    assert.equal(invForLiquidatingReject.status, 201);

    await prisma.contract.update({
      where: { id: contract.id },
      data: { status: CONTRACT_STATUS.LIQUIDATING },
    });

    const getLiquidating = await apiCall('GET', `/api/v1/contracts/${contract.id}/residents`, primary.id);
    assert.equal(getLiquidating.status, 200);
    assert.equal(getLiquidating.body.contractStatus, CONTRACT_STATUS.LIQUIDATING);

    const postLiquidating = await apiCall(
      'POST',
      `/api/v1/contracts/${contract.id}/invitations`,
      primary.id,
      { identifier: outsider.phone },
    );
    assert.equal(postLiquidating.status, 409);
    assert.equal(postLiquidating.body.code, 'CONTRACT_NOT_ACTIVE');

    const acceptLiquidating = await apiCall(
      'PATCH',
      `/api/v1/resident-invitations/${invForLiquidatingAccept.body.invitationId}/accept`,
      outsider.id,
    );
    assert.equal(acceptLiquidating.status, 409);
    assert.equal(acceptLiquidating.body.code, 'CONTRACT_NOT_ACTIVE');

    const deleteLiquidating = await apiCall(
      'DELETE',
      `/api/v1/contracts/${contract.id}/residents/${coRes2.id}`,
      primary.id,
    );
    assert.equal(deleteLiquidating.status, 409);
    assert.equal(deleteLiquidating.body.code, 'CONTRACT_NOT_ACTIVE');

    const rejectLiquidating = await apiCall(
      'PATCH',
      `/api/v1/resident-invitations/${invForLiquidatingReject.body.invitationId}/reject`,
      coRes1.id,
    );
    assert.equal(rejectLiquidating.status, 200);

    const cancelLiquidating = await apiCall(
      'PATCH',
      `/api/v1/resident-invitations/${invForLiquidatingAccept.body.invitationId}/cancel`,
      primary.id,
    );
    assert.equal(cancelLiquidating.status, 200);
  });
});
