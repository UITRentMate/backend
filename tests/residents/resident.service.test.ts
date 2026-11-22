import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { ApiError } from '../../src/common/errors/api-error';
import type { CurrentUser } from '../../src/common/middleware/require-role';
import { ResidentRepository } from '../../src/modules/residents/resident.repository';
import { ResidentService } from '../../src/modules/residents/resident.service';

const CONTRACT_ID = '11111111-2222-4333-8444-555555555555';
const INVITATION_ID = '22222222-3333-4444-8555-666666666666';
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

describe('ResidentService Architecture & Unit Tests', () => {
  test('Static architecture guard: resident.service.ts không import prisma singleton hoặc gọi prisma.*', () => {
    const serviceFilePath = path.join(__dirname, '../../src/modules/residents/resident.service.ts');
    const content = fs.readFileSync(serviceFilePath, 'utf8');

    assert.ok(!content.includes('infrastructure/database/prisma'));
    assert.ok(!/\bprisma\./.test(content));
  });

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
          id: 'room-1',
          roomCode: 'P.101',
          maxOccupants: 3,
          property: { id: 'prop-1', name: 'Hoa Mai' },
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
          id: 'room-1',
          roomCode: 'P.101',
          maxOccupants: 3,
          property: { id: 'prop-1', name: 'Hoa Mai' },
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
      (error: unknown) => {
        assert(error instanceof ApiError);
        assert.equal(error.statusCode, 404);
        assert.equal(error.code, 'CONTRACT_NOT_FOUND');
        return true;
      },
    );
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
      (error: unknown) => {
        assert(error instanceof ApiError);
        assert.equal(error.statusCode, 403);
        assert.equal(error.code, 'FORBIDDEN');
        return true;
      },
    );

    await assert.rejects(
      () =>
        ResidentService.createInvitation(
          CONTRACT_ID,
          { type: 'EMAIL', value: 'invite@rentmate.vn' },
          outsiderUser,
        ),
      (error: unknown) => {
        assert(error instanceof ApiError);
        assert.equal(error.statusCode, 404);
        assert.equal(error.code, 'CONTRACT_NOT_FOUND');
        return true;
      },
    );
  });

  test('createInvitation: Primary Tenant ủy quyền cho createInvitationInTx và map DTO', async () => {
    stubRepo('findContractAccessContext', async () => ({
      contractId: CONTRACT_ID,
      status: 'ACTIVE',
      tenantId: PRIMARY_ID,
      landlordId: LANDLORD_ID,
      isPrimaryTenant: true,
      isLandlord: false,
      isActiveCoResident: false,
    }));
    stubRepo('createInvitationInTx', async (params) => {
      assert.equal(params.contractId, CONTRACT_ID);
      assert.equal(params.invitedById, PRIMARY_ID);
      return {
        id: INVITATION_ID,
        contractId: CONTRACT_ID,
        status: 'PENDING',
        expiresAt: new Date('2026-11-25T12:00:00.000Z'),
        invitedUser: { id: INVITED_ID, fullName: 'Invited User', avatarUrl: null },
        invitedBy: { id: PRIMARY_ID, fullName: 'Primary Tenant', avatarUrl: null },
      };
    });

    const dto = await ResidentService.createInvitation(
      CONTRACT_ID,
      { type: 'PHONE', value: '0901234567' },
      primaryUser,
    );
    assert.equal(dto.invitationId, INVITATION_ID);
    assert.equal(dto.status, 'PENDING');
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
      () => ResidentService.cancelInvitation(INVITATION_ID, { ...outsiderUser, id: INVITED_ID }),
    ]) {
      await assert.rejects(call, (error: unknown) => {
        assert(error instanceof ApiError);
        assert.equal(error.statusCode, 404);
        assert.equal(error.code, 'INVITATION_NOT_FOUND');
        return true;
      });
    }
  });

  test('accept/reject/cancel: outcome EXPIRED ném 409 INVITATION_EXPIRED ngoài transaction', async () => {
    stubRepo('findInvitationAccessContext', async () => ({
      invitationId: INVITATION_ID,
      contractId: CONTRACT_ID,
      invitedUserId: INVITED_ID,
      invitedById: PRIMARY_ID,
      contractTenantId: PRIMARY_ID,
      landlordId: LANDLORD_ID,
    }));
    stubRepo('acceptInvitationInTx', async () => ({ outcome: 'EXPIRED' }));
    stubRepo('rejectInvitationInTx', async () => ({ outcome: 'EXPIRED' }));
    stubRepo('cancelInvitationInTx', async () => ({ outcome: 'EXPIRED' }));

    const invitedUser: CurrentUser = { ...outsiderUser, id: INVITED_ID };
    for (const call of [
      () => ResidentService.acceptInvitation(INVITATION_ID, invitedUser),
      () => ResidentService.rejectInvitation(INVITATION_ID, invitedUser),
      () => ResidentService.cancelInvitation(INVITATION_ID, landlordUser),
    ]) {
      await assert.rejects(call, (error: unknown) => {
        assert(error instanceof ApiError);
        assert.equal(error.statusCode, 409);
        assert.equal(error.code, 'INVITATION_EXPIRED');
        return true;
      });
    }
  });

  test('accept/reject/cancel: outcome thành công trả đúng DTO', async () => {
    stubRepo('findInvitationAccessContext', async () => ({
      invitationId: INVITATION_ID,
      contractId: CONTRACT_ID,
      invitedUserId: INVITED_ID,
      invitedById: PRIMARY_ID,
      contractTenantId: PRIMARY_ID,
      landlordId: LANDLORD_ID,
    }));
    stubRepo('acceptInvitationInTx', async () => ({
      outcome: 'ACCEPTED',
      data: {
        invitationId: INVITATION_ID,
        contractId: CONTRACT_ID,
        acceptedAt: new Date('2026-11-22T12:15:00.000Z'),
        resident: {
          user: { id: INVITED_ID, fullName: 'Invited User', avatarUrl: null },
          joinedAt: new Date('2026-11-22T12:15:00.000Z'),
        },
        currentOccupants: 2,
        maxOccupants: 3,
      },
    }));
    stubRepo('rejectInvitationInTx', async () => ({
      outcome: 'REJECTED',
      data: { invitationId: INVITATION_ID, contractId: CONTRACT_ID },
    }));
    stubRepo('cancelInvitationInTx', async () => ({
      outcome: 'CANCELLED',
      data: { invitationId: INVITATION_ID, contractId: CONTRACT_ID },
    }));

    const invitedUser: CurrentUser = { ...outsiderUser, id: INVITED_ID };
    const accepted = await ResidentService.acceptInvitation(INVITATION_ID, invitedUser);
    assert.equal(accepted.status, 'ACCEPTED');
    assert.equal(accepted.currentOccupants, 2);

    const rejected = await ResidentService.rejectInvitation(INVITATION_ID, invitedUser);
    assert.equal(rejected.status, 'REJECTED');

    const cancelled = await ResidentService.cancelInvitation(INVITATION_ID, primaryUser);
    assert.equal(cancelled.status, 'CANCELLED');
  });

  test('removeResident: kiểm tra đủ Anti-IDOR (404), CO_RESIDENT gỡ người khác (403), gỡ Primary (400), SELF_LEAVE và REMOVED_BY_*', async () => {
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

    const recordedRemovalTypes: string[] = [];
    stubRepo('removeResidentInTx', async (params) => {
      recordedRemovalTypes.push(params.removalType);
      return {
        contractId: params.contractId,
        userId: params.targetUserId,
        leftAt: new Date('2026-11-22T12:30:00.000Z'),
        removalType: params.removalType,
        currentOccupants: 1,
        maxOccupants: 3,
      };
    });

    // Outsider -> 404
    await assert.rejects(
      () => ResidentService.removeResident(CONTRACT_ID, CO_RESIDENT_ID, outsiderUser),
      (err: unknown) => err instanceof ApiError && err.statusCode === 404 && err.code === 'CONTRACT_NOT_FOUND',
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
        err instanceof ApiError && err.statusCode === 400 && err.code === 'CANNOT_REMOVE_PRIMARY_TENANT',
    );
    await assert.rejects(
      () => ResidentService.removeResident(CONTRACT_ID, PRIMARY_ID, landlordUser),
      (err: unknown) =>
        err instanceof ApiError && err.statusCode === 400 && err.code === 'CANNOT_REMOVE_PRIMARY_TENANT',
    );

    // Co-Resident self leave -> SELF_LEAVE
    const selfLeave = await ResidentService.removeResident(CONTRACT_ID, CO_RESIDENT_ID, coResidentUser);
    assert.equal(selfLeave.removalType, 'SELF_LEAVE');

    // Primary Tenant removing Co-Resident -> REMOVED_BY_PRIMARY_TENANT
    const removedByPrimary = await ResidentService.removeResident(
      CONTRACT_ID,
      CO_RESIDENT_ID,
      primaryUser,
    );
    assert.equal(removedByPrimary.removalType, 'REMOVED_BY_PRIMARY_TENANT');

    // Landlord removing Co-Resident -> REMOVED_BY_LANDLORD
    const removedByLandlord = await ResidentService.removeResident(
      CONTRACT_ID,
      CO_RESIDENT_ID,
      landlordUser,
    );
    assert.equal(removedByLandlord.removalType, 'REMOVED_BY_LANDLORD');

    assert.deepEqual(recordedRemovalTypes, [
      'SELF_LEAVE',
      'REMOVED_BY_PRIMARY_TENANT',
      'REMOVED_BY_LANDLORD',
    ]);
  });
});
