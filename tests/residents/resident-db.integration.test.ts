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

  async function createTestUser(
    role: 'TENANT' | 'LANDLORD',
    label: string,
    accountStatus: 'ACTIVE' | 'LOCKED' = 'ACTIVE',
  ) {
    const idx = createdUserIds.length + 1;
    const user = await prisma.user.create({
      data: {
        fullName: `${label} ${idx}`,
        email: `res-int-${uniqueBase}-${idx}-${Math.random().toString(36).slice(2, 7)}@rentmate.test`,
        phone: nextPhone(),
        passwordHash: 'test-only-hash',
        role,
        accountStatus,
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

    const createdAudit = await prisma.auditLog.findFirst({
      where: {
        entityType: 'RESIDENT_INVITATION',
        entityId: invReject.body.invitationId,
        action: 'RESIDENT_INVITATION_CREATED',
      },
    });
    assert.ok(createdAudit);
    assert.equal(createdAudit.actorId, landlord.id);
    assert.equal(createdAudit.oldData, null);
    assert.equal((createdAudit.newData as Record<string, unknown>)?.status, 'PENDING');
    assert.equal((createdAudit.newData as Record<string, unknown>)?.invitedUserId, outsider.id);

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

    const rejectAudit = await prisma.auditLog.findFirst({
      where: {
        entityType: 'RESIDENT_INVITATION',
        entityId: invReject.body.invitationId,
        action: 'RESIDENT_INVITATION_REJECTED',
      },
    });
    assert.ok(rejectAudit);
    assert.equal(rejectAudit.actorId, outsider.id);
    assert.equal((rejectAudit.oldData as Record<string, unknown>)?.status, 'PENDING');
    assert.equal((rejectAudit.newData as Record<string, unknown>)?.status, 'REJECTED');

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

    const cancelAudit = await prisma.auditLog.findFirst({
      where: {
        entityType: 'RESIDENT_INVITATION',
        entityId: invCancel.body.invitationId,
        action: 'RESIDENT_INVITATION_CANCELLED',
      },
    });
    assert.ok(cancelAudit);
    assert.equal(cancelAudit.actorId, primary.id);
    assert.equal((cancelAudit.oldData as Record<string, unknown>)?.status, 'PENDING');
    assert.equal((cancelAudit.newData as Record<string, unknown>)?.status, 'CANCELLED');
    assert.equal((cancelAudit.newData as Record<string, unknown>)?.cancelledById, primary.id);

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

  test('6. Regression: Notification.title được giới hạn <= 160 ký tự khi fullName (150) và roomCode (50) đạt độ dài tối đa', async (t) => {
    if (!dbReady) {
      t.skip('PostgreSQL is not available');
      return;
    }

    const landlord = await createTestUser('LANDLORD', 'Landlord Long');
    const primary = await createTestUser('TENANT', 'Primary Long');
    const longTenant = await prisma.user.create({
      data: {
        fullName: 'A'.repeat(150),
        email: `res-long-${uniqueBase}-${Math.random().toString(36).slice(2, 7)}@rentmate.test`,
        phone: nextPhone(),
        passwordHash: 'test-only-hash',
        role: 'TENANT',
        accountStatus: 'ACTIVE',
      },
    });
    createdUserIds.push(longTenant.id);

    const { contract } = await createTestContract({
      landlordId: landlord.id,
      primaryTenantId: primary.id,
      maxOccupants: 3,
      roomCode: 'R'.repeat(50),
    });

    // 1. Invite -> Accept -> Self-leave
    const invAccept = await apiCall('POST', `/api/v1/contracts/${contract.id}/invitations`, primary.id, {
      identifier: longTenant.email,
    });
    assert.equal(invAccept.status, 201);

    const accepted = await apiCall(
      'PATCH',
      `/api/v1/resident-invitations/${invAccept.body.invitationId}/accept`,
      longTenant.id,
    );
    assert.equal(accepted.status, 200);

    const selfLeft = await apiCall(
      'DELETE',
      `/api/v1/contracts/${contract.id}/residents/${longTenant.id}`,
      longTenant.id,
    );
    assert.equal(selfLeft.status, 200);

    // 2. Invite -> Reject
    const invReject = await apiCall('POST', `/api/v1/contracts/${contract.id}/invitations`, primary.id, {
      identifier: longTenant.email,
    });
    assert.equal(invReject.status, 201);

    const rejected = await apiCall(
      'PATCH',
      `/api/v1/resident-invitations/${invReject.body.invitationId}/reject`,
      longTenant.id,
    );
    assert.equal(rejected.status, 200);

    const notifs = await prisma.notification.findMany({
      where: {
        recipientId: { in: [landlord.id, primary.id, longTenant.id] },
      },
    });
    assert.ok(notifs.length >= 6);
    for (const notif of notifs) {
      assert.ok(notif.title.length <= 160, `Title vượt quá 160 ký tự: ${notif.title.length}`);
    }
  });

  test('7. REMOVED_BY_LANDLORD trên PostgreSQL thật: cập nhật leftAt, gửi 3 Notification RESIDENT_REMOVED và ghi AuditLog RESIDENT_REMOVED', async (t) => {
    if (!dbReady) {
      t.skip('PostgreSQL is not available');
      return;
    }

    const landlord = await createTestUser('LANDLORD', 'Landlord C7');
    const primary = await createTestUser('TENANT', 'Primary C7');
    const coRes = await createTestUser('TENANT', 'CoRes C7');
    const { contract } = await createTestContract({
      landlordId: landlord.id,
      primaryTenantId: primary.id,
      maxOccupants: 3,
      roomCode: 'P.207',
    });

    const inv = await apiCall('POST', `/api/v1/contracts/${contract.id}/invitations`, primary.id, {
      identifier: coRes.email,
    });
    assert.equal(inv.status, 201);
    const acc = await apiCall(
      'PATCH',
      `/api/v1/resident-invitations/${inv.body.invitationId}/accept`,
      coRes.id,
    );
    assert.equal(acc.status, 200);

    const removed = await apiCall(
      'DELETE',
      `/api/v1/contracts/${contract.id}/residents/${coRes.id}`,
      landlord.id,
    );
    assert.equal(removed.status, 200);
    assert.equal(removed.body.contractId, contract.id);
    assert.equal(removed.body.userId, coRes.id);
    assert.equal(removed.body.removalType, 'REMOVED_BY_LANDLORD');
    assert.equal(removed.body.currentOccupants, 1);
    assert.equal(removed.body.maxOccupants, 3);
    assert.equal(typeof removed.body.leftAt, 'string');

    const residentRow = await prisma.contractResident.findUnique({
      where: { contractId_userId: { contractId: contract.id, userId: coRes.id } },
    });
    assert.ok(residentRow?.leftAt !== null);

    const removedNotifs = await prisma.notification.findMany({
      where: {
        recipientId: { in: [landlord.id, primary.id, coRes.id] },
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
      const metadata = (notif.payload as Record<string, any>).metadata as Record<string, unknown>;
      assert.equal(metadata.removalType, 'REMOVED_BY_LANDLORD');
    }

    const removedAudit = await prisma.auditLog.findFirst({
      where: {
        entityType: 'CONTRACT_RESIDENT',
        entityId: contract.id,
        action: 'RESIDENT_REMOVED',
      },
    });
    assert.ok(removedAudit);
    assert.equal(removedAudit.actorId, landlord.id);
    assert.equal((removedAudit.oldData as Record<string, unknown>)?.leftAt, null);
    assert.equal((removedAudit.oldData as Record<string, unknown>)?.userId, coRes.id);
    assert.equal(
      (removedAudit.newData as Record<string, unknown>)?.removalType,
      'REMOVED_BY_LANDLORD',
    );
    assert.equal((removedAudit.newData as Record<string, unknown>)?.currentOccupants, 1);
  });

  test('8. Bao phủ 7 nhánh lỗi Repository trên PostgreSQL thật (404/400/409)', async (t) => {
    if (!dbReady) {
      t.skip('PostgreSQL is not available');
      return;
    }

    const landlord = await createTestUser('LANDLORD', 'Landlord C8');
    const primary = await createTestUser('TENANT', 'Primary C8');
    const coRes = await createTestUser('TENANT', 'CoRes C8');
    const lockedTenant = await createTestUser('TENANT', 'Locked C8', 'LOCKED');
    const extraTenant1 = await createTestUser('TENANT', 'Extra1 C8');
    const extraTenant2 = await createTestUser('TENANT', 'Extra2 C8');

    const { contract: fullContract } = await createTestContract({
      landlordId: landlord.id,
      primaryTenantId: primary.id,
      maxOccupants: 2,
      roomCode: 'P.208A',
    });

    // 1. 404 INVITEE_NOT_FOUND (email & phone không tồn tại)
    const missingEmailRes = await apiCall(
      'POST',
      `/api/v1/contracts/${fullContract.id}/invitations`,
      primary.id,
      { identifier: `nonexistent-${uniqueBase}@rentmate.test` },
    );
    assert.equal(missingEmailRes.status, 404);
    assert.equal(missingEmailRes.body.code, 'INVITEE_NOT_FOUND');

    const missingPhoneRes = await apiCall(
      'POST',
      `/api/v1/contracts/${fullContract.id}/invitations`,
      primary.id,
      { identifier: nextPhone() },
    );
    assert.equal(missingPhoneRes.status, 404);
    assert.equal(missingPhoneRes.body.code, 'INVITEE_NOT_FOUND');

    // 2. 400 INVITEE_NOT_ELIGIBLE (LANDLORD hoặc TENANT LOCKED)
    const inviteLandlordRes = await apiCall(
      'POST',
      `/api/v1/contracts/${fullContract.id}/invitations`,
      primary.id,
      { identifier: landlord.email },
    );
    assert.equal(inviteLandlordRes.status, 400);
    assert.equal(inviteLandlordRes.body.code, 'INVITEE_NOT_ELIGIBLE');

    const inviteLockedRes = await apiCall(
      'POST',
      `/api/v1/contracts/${fullContract.id}/invitations`,
      primary.id,
      { identifier: lockedTenant.phone },
    );
    assert.equal(inviteLockedRes.status, 400);
    assert.equal(inviteLockedRes.body.code, 'INVITEE_NOT_ELIGIBLE');

    // 3. 409 ALREADY_PRIMARY_TENANT
    const invitePrimaryRes = await apiCall(
      'POST',
      `/api/v1/contracts/${fullContract.id}/invitations`,
      landlord.id,
      { identifier: primary.email },
    );
    assert.equal(invitePrimaryRes.status, 409);
    assert.equal(invitePrimaryRes.body.code, 'ALREADY_PRIMARY_TENANT');

    // Đưa coRes vào ở cùng để test ALREADY_RESIDENT và ROOM_CAPACITY_EXCEEDED
    const invAccepted = await apiCall(
      'POST',
      `/api/v1/contracts/${fullContract.id}/invitations`,
      primary.id,
      { identifier: coRes.email },
    );
    assert.equal(invAccepted.status, 201);
    const accOk = await apiCall(
      'PATCH',
      `/api/v1/resident-invitations/${invAccepted.body.invitationId}/accept`,
      coRes.id,
    );
    assert.equal(accOk.status, 200);

    // 4. 409 ALREADY_RESIDENT
    const inviteActiveCoRes = await apiCall(
      'POST',
      `/api/v1/contracts/${fullContract.id}/invitations`,
      primary.id,
      { identifier: coRes.email },
    );
    assert.equal(inviteActiveCoRes.status, 409);
    assert.equal(inviteActiveCoRes.body.code, 'ALREADY_RESIDENT');

    // 5. 409 ROOM_CAPACITY_EXCEEDED ngay lúc POST /invitations
    const inviteWhenFull = await apiCall(
      'POST',
      `/api/v1/contracts/${fullContract.id}/invitations`,
      primary.id,
      { identifier: extraTenant1.email },
    );
    assert.equal(inviteWhenFull.status, 409);
    assert.equal(inviteWhenFull.body.code, 'ROOM_CAPACITY_EXCEEDED');

    // 6. 409 INVITATION_NOT_PENDING trên /accept, /reject, /cancel (với ACCEPTED, REJECTED, CANCELLED)
    const { contract: openContract } = await createTestContract({
      landlordId: landlord.id,
      primaryTenantId: primary.id,
      maxOccupants: 4,
      roomCode: 'P.208B',
    });

    const invForReject = await apiCall(
      'POST',
      `/api/v1/contracts/${openContract.id}/invitations`,
      primary.id,
      { identifier: extraTenant1.email },
    );
    assert.equal(invForReject.status, 201);
    assert.equal(
      (
        await apiCall(
          'PATCH',
          `/api/v1/resident-invitations/${invForReject.body.invitationId}/reject`,
          extraTenant1.id,
        )
      ).status,
      200,
    );

    const invForCancel = await apiCall(
      'POST',
      `/api/v1/contracts/${openContract.id}/invitations`,
      primary.id,
      { identifier: extraTenant2.email },
    );
    assert.equal(invForCancel.status, 201);
    assert.equal(
      (
        await apiCall(
          'PATCH',
          `/api/v1/resident-invitations/${invForCancel.body.invitationId}/cancel`,
          primary.id,
        )
      ).status,
      200,
    );

    const notPendingChecks: Array<[string, string, string]> = [
      ['accept', invAccepted.body.invitationId, coRes.id],
      ['reject', invAccepted.body.invitationId, coRes.id],
      ['cancel', invAccepted.body.invitationId, primary.id],
      ['accept', invForReject.body.invitationId, extraTenant1.id],
      ['reject', invForReject.body.invitationId, extraTenant1.id],
      ['cancel', invForReject.body.invitationId, primary.id],
      ['accept', invForCancel.body.invitationId, extraTenant2.id],
      ['reject', invForCancel.body.invitationId, extraTenant2.id],
      ['cancel', invForCancel.body.invitationId, primary.id],
    ];
    for (const [action, invitationId, actorId] of notPendingChecks) {
      const res = await apiCall(
        'PATCH',
        `/api/v1/resident-invitations/${invitationId}/${action}`,
        actorId,
      );
      assert.equal(res.status, 409, `${action} on ${invitationId} expected 409, got ${res.status}`);
      assert.equal(res.body.code, 'INVITATION_NOT_PENDING');
    }

    // 7. 404 RESIDENT_NOT_FOUND ở DELETE /residents/:userId (user chưa từng ở & user đã rời phòng)
    const removeNonResident = await apiCall(
      'DELETE',
      `/api/v1/contracts/${fullContract.id}/residents/${extraTenant1.id}`,
      primary.id,
    );
    assert.equal(removeNonResident.status, 404);
    assert.equal(removeNonResident.body.code, 'RESIDENT_NOT_FOUND');

    const removeCoResFirst = await apiCall(
      'DELETE',
      `/api/v1/contracts/${fullContract.id}/residents/${coRes.id}`,
      primary.id,
    );
    assert.equal(removeCoResFirst.status, 200);

    const removeCoResAgain = await apiCall(
      'DELETE',
      `/api/v1/contracts/${fullContract.id}/residents/${coRes.id}`,
      primary.id,
    );
    assert.equal(removeCoResAgain.status, 404);
    assert.equal(removeCoResAgain.body.code, 'RESIDENT_NOT_FOUND');
  });
});
