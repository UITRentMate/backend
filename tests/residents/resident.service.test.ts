import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { ApiError } from '../../src/common/errors/api-error';
import type { CurrentUser } from '../../src/common/middleware/require-role';
import { prisma } from '../../src/infrastructure/database/prisma';
import { ResidentRepository } from '../../src/modules/residents/resident.repository';
import { ResidentService } from '../../src/modules/residents/resident.service';
import type {
  ContractMutationRow,
  LockedInvitationRow,
} from '../../src/modules/residents/resident.types';

const CONTRACT_ID = '11111111-2222-4333-8444-555555555555';
const INVITATION_ID = '22222222-3333-4444-8555-666666666666';
const ROOM_ID = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
const PROP_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PRIMARY_ID = '33333333-4444-4555-8666-777777777777';
const LANDLORD_ID = '44444444-5555-4666-8777-888888888888';
const CO_RESIDENT_ID = '55555555-6666-4777-8888-999999999999';
const OTHER_CO_RESIDENT_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const INVITED_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const OUTSIDER_ID = '88888888-9999-4aaa-8bbb-cccccccccccc';

const primaryUser: CurrentUser = {
  id: PRIMARY_ID,
  role: 'TENANT',
  accountStatus: 'ACTIVE',
  fullName: 'Primary Tenant',
};
const landlordUser: CurrentUser = {
  id: LANDLORD_ID,
  role: 'LANDLORD',
  accountStatus: 'ACTIVE',
  fullName: 'Landlord',
};
const coResidentUser: CurrentUser = {
  id: CO_RESIDENT_ID,
  role: 'TENANT',
  accountStatus: 'ACTIVE',
  fullName: 'Co Resident',
};
const invitedUser: CurrentUser = {
  id: INVITED_ID,
  role: 'TENANT',
  accountStatus: 'ACTIVE',
  fullName: 'Invited User',
};
const outsiderUser: CurrentUser = {
  id: OUTSIDER_ID,
  role: 'TENANT',
  accountStatus: 'ACTIVE',
  fullName: 'Outsider',
};

const restorers: Array<() => void> = [];
afterEach(() => {
  while (restorers.length > 0) {
    restorers.pop()!();
  }
});

function stubRepo<K extends keyof typeof ResidentRepository>(
  method: K,
  impl: (typeof ResidentRepository)[K],
) {
  const original = ResidentRepository[method];
  (ResidentRepository as Record<string, unknown>)[method] = impl;
  restorers.push(() => {
    (ResidentRepository as Record<string, unknown>)[method] = original;
  });
}

interface MockTxCapture {
  tx: Record<string, any>;
  notifications: Array<Record<string, any>>;
  auditLogs: Array<Record<string, any>>;
  committedCount: () => number;
}

function stubTransaction(): MockTxCapture {
  const notifications: Array<Record<string, any>> = [];
  const auditLogs: Array<Record<string, any>> = [];
  let commits = 0;

  const tx = {
    notification: {
      create: async ({ data }: { data: Record<string, any> }) => {
        notifications.push(data);
        return { id: `notif-${notifications.length}`, ...data };
      },
      createMany: async ({ data }: { data: Array<Record<string, any>> }) => {
        notifications.push(...data);
        return { count: data.length };
      },
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, any> }) => {
        auditLogs.push(data);
        return { id: `audit-${auditLogs.length}`, ...data };
      },
    },
  };

  const original = prisma.$transaction;
  (prisma as unknown as { $transaction: unknown }).$transaction = async (
    work: (client: unknown) => Promise<unknown>,
  ) => {
    const result = await work(tx);
    commits += 1;
    return result;
  };
  restorers.push(() => {
    (prisma as unknown as { $transaction: unknown }).$transaction = original;
  });

  return {
    tx,
    notifications,
    auditLogs,
    committedCount: () => commits,
  };
}

function makeContractMutationRow(overrides: Partial<ContractMutationRow> = {}): ContractMutationRow {
  return {
    id: CONTRACT_ID,
    status: 'ACTIVE',
    tenantId: PRIMARY_ID,
    room: {
      id: ROOM_ID,
      roomCode: 'P.101',
      maxOccupants: 3,
      property: {
        id: PROP_ID,
        landlordId: LANDLORD_ID,
      },
    },
    ...overrides,
  };
}

function makeLockedInvitationRow(overrides: Partial<LockedInvitationRow> = {}): LockedInvitationRow {
  return {
    id: INVITATION_ID,
    contractId: CONTRACT_ID,
    invitedUserId: INVITED_ID,
    invitedById: PRIMARY_ID,
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    invitedUser: { id: INVITED_ID, fullName: 'Invited User', avatarUrl: null },
    contract: makeContractMutationRow(),
    ...overrides,
  };
}

describe('ResidentService & ResidentRepository Architecture Guard', () => {
  test('AGENTS.md §2.2: resident.repository.ts chỉ chứa persistence & row-locking (không $transaction, ApiError, notification, auditLog)', () => {
    const repoPath = path.join(__dirname, '../../src/modules/residents/resident.repository.ts');
    const content = fs.readFileSync(repoPath, 'utf8');

    assert.ok(!content.includes('$transaction'), 'Repository must not call $transaction');
    assert.ok(!content.includes('ApiError'), 'Repository must not import or throw ApiError');
    assert.ok(!content.includes('createNotification'), 'Repository must not create notifications');
    assert.ok(!content.includes('recordAuditLog'), 'Repository must not record audit logs');
    assert.ok(content.includes('lockContractRow'), 'Repository must expose lockContractRow');
  });

  test('AGENTS.md §2.2: resident.service.ts dùng prisma.$transaction nhưng không truy vấn trực tiếp prisma.<model> hoặc $queryRaw', () => {
    const servicePath = path.join(__dirname, '../../src/modules/residents/resident.service.ts');
    const content = fs.readFileSync(servicePath, 'utf8');

    assert.ok(content.includes('prisma.$transaction'), 'Service must coordinate $transaction');
    assert.ok(!/\bprisma\.(?!\$transaction\b)/.test(content), 'Service must delegate DB queries to ResidentRepository');
  });
});

describe('ResidentService Unit Tests', () => {
  test('getContractResidents: Primary Tenant nhận pendingInvitations array và expire lời mời cũ', async () => {
    let expireCalled = false;
    let receivedIncludePending: boolean | undefined;

    stubRepo('findContractAccessContext', async () => ({
      contractId: CONTRACT_ID,
      status: 'ACTIVE',
      tenantId: PRIMARY_ID,
      landlordId: LANDLORD_ID,
      isPrimaryTenant: true,
      isLandlord: false,
      isActiveCoResident: false,
    }));
    stubRepo('expireContractPendingInvitations', async (id) => {
      assert.equal(id, CONTRACT_ID);
      expireCalled = true;
      return 1;
    });
    stubRepo('findContractResidentsDetail', async (_id, includePending) => {
      receivedIncludePending = includePending;
      return {
        id: CONTRACT_ID,
        status: 'ACTIVE',
        activatedAt: new Date('2026-11-01T08:00:00.000Z'),
        tenant: { id: PRIMARY_ID, fullName: 'Primary Tenant', avatarUrl: null },
        room: {
          id: ROOM_ID,
          roomCode: 'P.101',
          maxOccupants: 3,
          property: { id: PROP_ID, name: 'Hoa Mai' },
        },
        contractResidents: [],
        residentInvitations: [],
      };
    });

    const dto = await ResidentService.getContractResidents(CONTRACT_ID, primaryUser);
    assert.equal(expireCalled, true);
    assert.equal(receivedIncludePending, true);
    assert.deepEqual(dto.pendingInvitations, []);
  });

  test('getContractResidents: Active Co-Resident nhận pendingInvitations = null', async () => {
    let expireCalled = false;

    stubRepo('findContractAccessContext', async () => ({
      contractId: CONTRACT_ID,
      status: 'ACTIVE',
      tenantId: PRIMARY_ID,
      landlordId: LANDLORD_ID,
      isPrimaryTenant: false,
      isLandlord: false,
      isActiveCoResident: true,
    }));
    stubRepo('expireContractPendingInvitations', async () => {
      expireCalled = true;
      return 0;
    });
    stubRepo('findContractResidentsDetail', async (_id, includePending) => {
      assert.equal(includePending, false);
      return {
        id: CONTRACT_ID,
        status: 'ACTIVE',
        activatedAt: new Date('2026-11-01T08:00:00.000Z'),
        tenant: { id: PRIMARY_ID, fullName: 'Primary Tenant', avatarUrl: null },
        room: {
          id: ROOM_ID,
          roomCode: 'P.101',
          maxOccupants: 3,
          property: { id: PROP_ID, name: 'Hoa Mai' },
        },
        contractResidents: [
          {
            userId: CO_RESIDENT_ID,
            joinedAt: new Date('2026-11-02T08:00:00.000Z'),
            user: { id: CO_RESIDENT_ID, fullName: 'Co Resident', avatarUrl: null },
          },
        ],
        residentInvitations: [],
      };
    });

    const dto = await ResidentService.getContractResidents(CONTRACT_ID, coResidentUser);
    assert.equal(expireCalled, false);
    assert.equal(dto.pendingInvitations, null);
    assert.equal(dto.currentOccupants, 2);
  });

  test('getContractResidents: Outsider / Former Co-Resident nhận 404 CONTRACT_NOT_FOUND', async () => {
    stubRepo('findContractAccessContext', async () => null);

    await assert.rejects(
      () => ResidentService.getContractResidents(CONTRACT_ID, outsiderUser),
      (error: unknown) =>
        error instanceof ApiError && error.statusCode === 404 && error.code === 'CONTRACT_NOT_FOUND',
    );
  });

  test('listMyInvitations: tự expire lời mời cũ trước khi lấy danh sách phân trang', async () => {
    const callOrder: string[] = [];

    stubRepo('expireUserPendingInvitations', async (userId) => {
      assert.equal(userId, INVITED_ID);
      callOrder.push('expire');
      return 1;
    });
    stubRepo('findReceivedInvitations', async (userId, query) => {
      assert.equal(userId, INVITED_ID);
      assert.equal(query.page, 1);
      assert.equal(query.limit, 10);
      callOrder.push('find');
      return {
        items: [
          {
            id: INVITATION_ID,
            contractId: CONTRACT_ID,
            status: 'PENDING',
            expiresAt: new Date('2026-11-25T12:00:00.000Z'),
            acceptedAt: null,
            contract: {
              room: {
                id: ROOM_ID,
                roomCode: 'P.101',
                maxOccupants: 3,
                property: { id: PROP_ID, name: 'Hoa Mai', address: '123 Đường D1' },
              },
            },
            invitedBy: { id: PRIMARY_ID, fullName: 'Primary Tenant', avatarUrl: null },
          },
        ],
        total: 11,
      };
    });

    const dto = await ResidentService.listMyInvitations({ page: 1, limit: 10 }, invitedUser);
    assert.deepEqual(callOrder, ['expire', 'find']);
    assert.equal(dto.total, 11);
    assert.equal(dto.totalPages, 2);
    assert.equal(dto.items[0].invitationId, INVITATION_ID);
  });

  test('createInvitation: Active Co-Resident bị chặn 403 FORBIDDEN; Outsider nhận 404', async () => {
    stubRepo('findContractAccessContext', async (_contractId, userId) => {
      if (userId === CO_RESIDENT_ID) {
        return {
          contractId: CONTRACT_ID,
          status: 'ACTIVE',
          tenantId: PRIMARY_ID,
          landlordId: LANDLORD_ID,
          isPrimaryTenant: false,
          isLandlord: false,
          isActiveCoResident: true,
        };
      }
      return null;
    });

    await assert.rejects(
      () =>
        ResidentService.createInvitation(
          CONTRACT_ID,
          { type: 'EMAIL', value: 'invite@rentmate.vn' },
          coResidentUser,
        ),
      (error: unknown) =>
        error instanceof ApiError && error.statusCode === 403 && error.code === 'FORBIDDEN',
    );

    await assert.rejects(
      () =>
        ResidentService.createInvitation(
          CONTRACT_ID,
          { type: 'EMAIL', value: 'invite@rentmate.vn' },
          outsiderUser,
        ),
      (error: unknown) =>
        error instanceof ApiError && error.statusCode === 404 && error.code === 'CONTRACT_NOT_FOUND',
    );
  });

  test('createInvitation: khóa hàng Contract trước khi kiểm tra nghiệp vụ, tạo lời mời + notification + audit log', async () => {
    const capture = stubTransaction();
    const callOrder: string[] = [];

    stubRepo('findContractAccessContext', async () => ({
      contractId: CONTRACT_ID,
      status: 'ACTIVE',
      tenantId: PRIMARY_ID,
      landlordId: LANDLORD_ID,
      isPrimaryTenant: true,
      isLandlord: false,
      isActiveCoResident: false,
    }));
    stubRepo('lockContractRow', async (tx, contractId) => {
      assert.equal(tx, capture.tx);
      assert.equal(contractId, CONTRACT_ID);
      callOrder.push('lock');
      return true;
    });
    stubRepo('findContractForMutation', async (tx) => {
      assert.equal(tx, capture.tx);
      callOrder.push('findContract');
      return makeContractMutationRow();
    });
    stubRepo('findUserByInviteIdentifier', async (tx, identifier) => {
      assert.equal(tx, capture.tx);
      assert.deepEqual(identifier, { type: 'PHONE', value: '0901234567' });
      callOrder.push('findUser');
      return {
        id: INVITED_ID,
        fullName: 'Invited User',
        avatarUrl: null,
        role: 'TENANT',
        accountStatus: 'ACTIVE',
      };
    });
    stubRepo('findContractResident', async () => {
      callOrder.push('findResident');
      return null;
    });
    stubRepo('expireContractInvitationsForUser', async () => {
      callOrder.push('expireOld');
      return 0;
    });
    stubRepo('findActivePendingInvitation', async () => {
      callOrder.push('findPending');
      return null;
    });
    stubRepo('countActiveCoResidents', async () => {
      callOrder.push('countActive');
      return 1;
    });
    stubRepo('createResidentInvitation', async (tx, data) => {
      assert.equal(tx, capture.tx);
      assert.equal(data.contractId, CONTRACT_ID);
      assert.equal(data.invitedUserId, INVITED_ID);
      assert.equal(data.invitedById, PRIMARY_ID);
      callOrder.push('createInvitation');
      return {
        id: INVITATION_ID,
        contractId: CONTRACT_ID,
        status: 'PENDING',
        expiresAt: data.expiresAt,
        invitedUser: { id: INVITED_ID, fullName: 'Invited User', avatarUrl: null },
        invitedBy: { id: PRIMARY_ID, fullName: 'Primary Tenant', avatarUrl: null },
      };
    });

    const dto = await ResidentService.createInvitation(
      CONTRACT_ID,
      { type: 'PHONE', value: '0901234567' },
      primaryUser,
    );

    assert.equal(callOrder[0], 'lock');
    assert.deepEqual(callOrder, [
      'lock',
      'findContract',
      'findUser',
      'findResident',
      'expireOld',
      'findPending',
      'countActive',
      'createInvitation',
    ]);
    assert.equal(capture.committedCount(), 1);
    assert.equal(capture.notifications.length, 1);
    assert.equal(capture.notifications[0].eventType, 'RESIDENT_INVITATION_RECEIVED');
    assert.equal(capture.notifications[0].recipientId, INVITED_ID);
    assert.equal(capture.auditLogs.length, 1);
    assert.equal(capture.auditLogs[0].action, 'RESIDENT_INVITATION_CREATED');
    assert.equal(dto.invitationId, INVITATION_ID);
    assert.equal(dto.status, 'PENDING');
  });

  test('createInvitation: kiểm tra đầy đủ các nhánh lỗi nghiệp vụ trong Service', async () => {
    stubTransaction();
    stubRepo('findContractAccessContext', async () => ({
      contractId: CONTRACT_ID,
      status: 'ACTIVE',
      tenantId: PRIMARY_ID,
      landlordId: LANDLORD_ID,
      isPrimaryTenant: true,
      isLandlord: false,
      isActiveCoResident: false,
    }));
    stubRepo('lockContractRow', async () => true);

    const expectRejectCode = async (expectedStatus: number, expectedCode: string) => {
      await assert.rejects(
        () =>
          ResidentService.createInvitation(
            CONTRACT_ID,
            { type: 'EMAIL', value: 'invitee@rentmate.vn' },
            primaryUser,
          ),
        (err: unknown) =>
          err instanceof ApiError && err.statusCode === expectedStatus && err.code === expectedCode,
      );
    };

    // 1. CONTRACT_NOT_ACTIVE
    stubRepo('findContractForMutation', async () => makeContractMutationRow({ status: 'LIQUIDATING' }));
    await expectRejectCode(409, 'CONTRACT_NOT_ACTIVE');

    // Reset active contract
    stubRepo('findContractForMutation', async () => makeContractMutationRow());

    // 2. INVITEE_NOT_FOUND
    stubRepo('findUserByInviteIdentifier', async () => null);
    await expectRejectCode(404, 'INVITEE_NOT_FOUND');

    // 3. INVITEE_NOT_ELIGIBLE (wrong role / locked)
    stubRepo('findUserByInviteIdentifier', async () => ({
      id: INVITED_ID,
      fullName: 'Landlord Target',
      avatarUrl: null,
      role: 'LANDLORD',
      accountStatus: 'ACTIVE',
    }));
    await expectRejectCode(400, 'INVITEE_NOT_ELIGIBLE');

    stubRepo('findUserByInviteIdentifier', async () => ({
      id: INVITED_ID,
      fullName: 'Locked Tenant',
      avatarUrl: null,
      role: 'TENANT',
      accountStatus: 'LOCKED',
    }));
    await expectRejectCode(400, 'INVITEE_NOT_ELIGIBLE');

    // 4. ALREADY_PRIMARY_TENANT
    stubRepo('findUserByInviteIdentifier', async () => ({
      id: PRIMARY_ID,
      fullName: 'Primary Tenant',
      avatarUrl: null,
      role: 'TENANT',
      accountStatus: 'ACTIVE',
    }));
    await expectRejectCode(409, 'ALREADY_PRIMARY_TENANT');

    // Reset eligible invitee
    stubRepo('findUserByInviteIdentifier', async () => ({
      id: INVITED_ID,
      fullName: 'Invited User',
      avatarUrl: null,
      role: 'TENANT',
      accountStatus: 'ACTIVE',
    }));

    // 5. ALREADY_RESIDENT
    stubRepo('findContractResident', async () => ({
      joinedAt: new Date(),
      leftAt: null,
      user: { id: INVITED_ID, fullName: 'Invited User' },
    }));
    await expectRejectCode(409, 'ALREADY_RESIDENT');

    // Reset non-resident + expire helper
    stubRepo('findContractResident', async () => null);
    stubRepo('expireContractInvitationsForUser', async () => 0);

    // 6. INVITATION_ALREADY_PENDING
    stubRepo('findActivePendingInvitation', async () => ({ id: INVITATION_ID }));
    await expectRejectCode(409, 'INVITATION_ALREADY_PENDING');

    // 7. ROOM_CAPACITY_EXCEEDED
    stubRepo('findActivePendingInvitation', async () => null);
    stubRepo('countActiveCoResidents', async () => 2); // 1 + 2 >= maxOccupants(3)
    await expectRejectCode(409, 'ROOM_CAPACITY_EXCEEDED');
  });

  test('accept/reject/cancel: Anti-IDOR trả 404 INVITATION_NOT_FOUND khi không thuộc quyền', async () => {
    stubRepo('findInvitationAccessContext', async () => ({
      invitationId: INVITATION_ID,
      contractId: CONTRACT_ID,
      invitedUserId: INVITED_ID,
      invitedById: PRIMARY_ID,
      contractTenantId: PRIMARY_ID,
      landlordId: LANDLORD_ID,
    }));

    for (const call of [
      () => ResidentService.acceptInvitation(INVITATION_ID, outsiderUser),
      () => ResidentService.rejectInvitation(INVITATION_ID, outsiderUser),
      () => ResidentService.cancelInvitation(INVITATION_ID, coResidentUser),
      () => ResidentService.cancelInvitation(INVITATION_ID, invitedUser),
    ]) {
      await assert.rejects(
        call,
        (error: unknown) =>
          error instanceof ApiError &&
          error.statusCode === 404 &&
          error.code === 'INVITATION_NOT_FOUND',
      );
    }
  });

  test('accept/reject/cancel: lazy-expire cập nhật EXPIRED, COMMIT transaction trước khi ném 409 INVITATION_EXPIRED', async () => {
    const capture = stubTransaction();
    const updatedStatuses: string[] = [];

    stubRepo('findInvitationAccessContext', async () => ({
      invitationId: INVITATION_ID,
      contractId: CONTRACT_ID,
      invitedUserId: INVITED_ID,
      invitedById: PRIMARY_ID,
      contractTenantId: PRIMARY_ID,
      landlordId: LANDLORD_ID,
    }));
    stubRepo('findInvitationContractId', async () => ({ contractId: CONTRACT_ID }));
    stubRepo('lockContractRow', async () => true);
    stubRepo('findInvitationForMutation', async () =>
      makeLockedInvitationRow({ expiresAt: new Date(Date.now() - 60_000) }),
    );
    stubRepo('updateInvitationStatus', async (_tx, _id, data) => {
      updatedStatuses.push(data.status);
    });

    for (const call of [
      () => ResidentService.acceptInvitation(INVITATION_ID, invitedUser),
      () => ResidentService.rejectInvitation(INVITATION_ID, invitedUser),
      () => ResidentService.cancelInvitation(INVITATION_ID, landlordUser),
    ]) {
      await assert.rejects(
        call,
        (error: unknown) =>
          error instanceof ApiError &&
          error.statusCode === 409 &&
          error.code === 'INVITATION_EXPIRED',
      );
    }

    assert.deepEqual(updatedStatuses, ['EXPIRED', 'EXPIRED', 'EXPIRED']);
    assert.equal(capture.committedCount(), 3);
    assert.equal(capture.notifications.length, 0);
    assert.equal(capture.auditLogs.length, 0);
  });

  test('acceptInvitation: khóa hàng trước, upsert resident (rejoin), deduplicate notifications và ghi AuditLog', async () => {
    const capture = stubTransaction();
    const callOrder: string[] = [];

    stubRepo('findInvitationAccessContext', async () => ({
      invitationId: INVITATION_ID,
      contractId: CONTRACT_ID,
      invitedUserId: INVITED_ID,
      invitedById: PRIMARY_ID,
      contractTenantId: PRIMARY_ID,
      landlordId: LANDLORD_ID,
    }));
    stubRepo('findInvitationContractId', async () => {
      callOrder.push('meta');
      return { contractId: CONTRACT_ID };
    });
    stubRepo('lockContractRow', async () => {
      callOrder.push('lock');
      return true;
    });
    stubRepo('findInvitationForMutation', async () => {
      callOrder.push('loadInvitation');
      return makeLockedInvitationRow();
    });
    stubRepo('findContractResident', async () => ({
      joinedAt: new Date('2026-10-01T00:00:00.000Z'),
      leftAt: new Date('2026-10-15T00:00:00.000Z'),
      user: { id: INVITED_ID, fullName: 'Invited User' },
    }));
    stubRepo('countActiveCoResidents', async () => 1);
    stubRepo('upsertContractResident', async (_tx, data) => {
      assert.equal(data.contractId, CONTRACT_ID);
      assert.equal(data.userId, INVITED_ID);
      assert.equal(data.leftAt, null);
      callOrder.push('upsert');
    });
    stubRepo('updateInvitationStatus', async (_tx, _id, data) => {
      assert.equal(data.status, 'ACCEPTED');
      callOrder.push('updateInvitation');
    });

    const dto = await ResidentService.acceptInvitation(INVITATION_ID, invitedUser);
    assert.deepEqual(callOrder, ['meta', 'lock', 'loadInvitation', 'upsert', 'updateInvitation']);
    assert.equal(dto.status, 'ACCEPTED');
    assert.equal(dto.currentOccupants, 3);
    assert.equal(dto.maxOccupants, 3);
    assert.equal(capture.committedCount(), 1);
    assert.equal(capture.notifications.length, 2);
    assert.equal(capture.auditLogs.length, 1);
    assert.equal(capture.auditLogs[0].action, 'RESIDENT_INVITATION_ACCEPTED');
    assert.deepEqual(capture.auditLogs[0].oldData.previousResident, {
      joinedAt: '2026-10-01T00:00:00.000Z',
      leftAt: '2026-10-15T00:00:00.000Z',
    });
  });

  test('acceptInvitation: kiểm tra ROOM_CAPACITY_EXCEEDED và CONTRACT_NOT_ACTIVE', async () => {
    stubTransaction();
    stubRepo('findInvitationAccessContext', async () => ({
      invitationId: INVITATION_ID,
      contractId: CONTRACT_ID,
      invitedUserId: INVITED_ID,
      invitedById: PRIMARY_ID,
      contractTenantId: PRIMARY_ID,
      landlordId: LANDLORD_ID,
    }));
    stubRepo('findInvitationContractId', async () => ({ contractId: CONTRACT_ID }));
    stubRepo('lockContractRow', async () => true);

    stubRepo('findInvitationForMutation', async () =>
      makeLockedInvitationRow({ contract: makeContractMutationRow({ status: 'TERMINATED' }) }),
    );
    await assert.rejects(
      () => ResidentService.acceptInvitation(INVITATION_ID, invitedUser),
      (err: unknown) =>
        err instanceof ApiError && err.statusCode === 409 && err.code === 'CONTRACT_NOT_ACTIVE',
    );

    stubRepo('findInvitationForMutation', async () => makeLockedInvitationRow());
    stubRepo('findContractResident', async () => null);
    stubRepo('countActiveCoResidents', async () => 2);
    await assert.rejects(
      () => ResidentService.acceptInvitation(INVITATION_ID, invitedUser),
      (err: unknown) =>
        err instanceof ApiError && err.statusCode === 409 && err.code === 'ROOM_CAPACITY_EXCEEDED',
    );
  });

  test('rejectInvitation & cancelInvitation: cập nhật trạng thái, gửi Notification và ghi AuditLog đúng', async () => {
    const capture = stubTransaction();
    stubRepo('findInvitationAccessContext', async () => ({
      invitationId: INVITATION_ID,
      contractId: CONTRACT_ID,
      invitedUserId: INVITED_ID,
      invitedById: LANDLORD_ID,
      contractTenantId: PRIMARY_ID,
      landlordId: LANDLORD_ID,
    }));
    stubRepo('findInvitationContractId', async () => ({ contractId: CONTRACT_ID }));
    stubRepo('lockContractRow', async () => true);
    stubRepo('findInvitationForMutation', async () =>
      makeLockedInvitationRow({ invitedById: LANDLORD_ID }),
    );
    stubRepo('updateInvitationStatus', async () => {});

    const rejected = await ResidentService.rejectInvitation(INVITATION_ID, invitedUser);
    assert.equal(rejected.status, 'REJECTED');

    const cancelled = await ResidentService.cancelInvitation(INVITATION_ID, primaryUser);
    assert.equal(cancelled.status, 'CANCELLED');

    assert.equal(capture.committedCount(), 2);
    assert.equal(capture.notifications.length, 2);
    assert.equal(capture.notifications[0].eventType, 'RESIDENT_INVITATION_REJECTED');
    assert.equal(capture.notifications[0].recipientId, LANDLORD_ID);
    assert.equal(capture.notifications[0].payload.actionUrl, `/landlord/contracts/${CONTRACT_ID}/residents`);
    assert.equal(capture.notifications[1].eventType, 'RESIDENT_INVITATION_CANCELLED');
    assert.equal(capture.notifications[1].recipientId, INVITED_ID);
    assert.equal(capture.auditLogs.length, 2);
    assert.equal(capture.auditLogs[0].action, 'RESIDENT_INVITATION_REJECTED');
    assert.equal(capture.auditLogs[1].action, 'RESIDENT_INVITATION_CANCELLED');
  });

  test('removeResident: kiểm tra Anti-IDOR (404), CO_RESIDENT gỡ người khác (403), gỡ Primary (400), RESIDENT_NOT_FOUND (404), SELF_LEAVE và REMOVED_BY_*', async () => {
    const capture = stubTransaction();

    stubRepo('findContractAccessContext', async (_contractId, userId) => {
      if (userId === OUTSIDER_ID) return null;
      return {
        contractId: CONTRACT_ID,
        status: 'ACTIVE',
        tenantId: PRIMARY_ID,
        landlordId: LANDLORD_ID,
        isPrimaryTenant: userId === PRIMARY_ID,
        isLandlord: userId === LANDLORD_ID,
        isActiveCoResident: userId === CO_RESIDENT_ID,
      };
    });

    // Outsider -> 404
    await assert.rejects(
      () => ResidentService.removeResident(CONTRACT_ID, CO_RESIDENT_ID, outsiderUser),
      (err: unknown) =>
        err instanceof ApiError && err.statusCode === 404 && err.code === 'CONTRACT_NOT_FOUND',
    );

    // Co-Resident removing another Co-Resident or Primary Tenant -> 403
    await assert.rejects(
      () => ResidentService.removeResident(CONTRACT_ID, OTHER_CO_RESIDENT_ID, coResidentUser),
      (err: unknown) => err instanceof ApiError && err.statusCode === 403 && err.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => ResidentService.removeResident(CONTRACT_ID, PRIMARY_ID, coResidentUser),
      (err: unknown) => err instanceof ApiError && err.statusCode === 403 && err.code === 'FORBIDDEN',
    );

    // Primary Tenant / Landlord removing Primary Tenant -> 400 CANNOT_REMOVE_PRIMARY_TENANT
    await assert.rejects(
      () => ResidentService.removeResident(CONTRACT_ID, PRIMARY_ID, primaryUser),
      (err: unknown) =>
        err instanceof ApiError &&
        err.statusCode === 400 &&
        err.code === 'CANNOT_REMOVE_PRIMARY_TENANT',
    );
    await assert.rejects(
      () => ResidentService.removeResident(CONTRACT_ID, PRIMARY_ID, landlordUser),
      (err: unknown) =>
        err instanceof ApiError &&
        err.statusCode === 400 &&
        err.code === 'CANNOT_REMOVE_PRIMARY_TENANT',
    );

    // Inside tx: lock + active resident missing -> 404 RESIDENT_NOT_FOUND
    stubRepo('lockContractRow', async () => true);
    stubRepo('findContractForMutation', async () => makeContractMutationRow());
    stubRepo('findContractResident', async () => null);
    await assert.rejects(
      () => ResidentService.removeResident(CONTRACT_ID, CO_RESIDENT_ID, primaryUser),
      (err: unknown) =>
        err instanceof ApiError && err.statusCode === 404 && err.code === 'RESIDENT_NOT_FOUND',
    );

    // Active resident exists -> SELF_LEAVE, REMOVED_BY_PRIMARY_TENANT, REMOVED_BY_LANDLORD
    stubRepo('findContractResident', async () => ({
      joinedAt: new Date('2026-11-02T08:00:00.000Z'),
      leftAt: null,
      user: { id: CO_RESIDENT_ID, fullName: 'Co Resident' },
    }));
    stubRepo('markResidentLeft', async () => {});
    stubRepo('countActiveCoResidents', async () => 0);

    const selfLeave = await ResidentService.removeResident(
      CONTRACT_ID,
      CO_RESIDENT_ID,
      coResidentUser,
    );
    assert.equal(selfLeave.removalType, 'SELF_LEAVE');
    assert.equal(selfLeave.currentOccupants, 1);

    const removedByPrimary = await ResidentService.removeResident(
      CONTRACT_ID,
      CO_RESIDENT_ID,
      primaryUser,
    );
    assert.equal(removedByPrimary.removalType, 'REMOVED_BY_PRIMARY_TENANT');

    const removedByLandlord = await ResidentService.removeResident(
      CONTRACT_ID,
      CO_RESIDENT_ID,
      landlordUser,
    );
    assert.equal(removedByLandlord.removalType, 'REMOVED_BY_LANDLORD');

    assert.equal(capture.committedCount(), 3);
    assert.equal(capture.notifications.length, 9);
    assert.deepEqual(
      capture.auditLogs.map((a) => a.action),
      ['RESIDENT_SELF_LEFT', 'RESIDENT_REMOVED', 'RESIDENT_REMOVED'],
    );
  });
});
