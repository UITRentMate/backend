import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, test } from 'node:test';
import { app } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { signAccessToken } from '../../src/modules/auth/auth.security';
import { ResidentService } from '../../src/modules/residents/resident.service';

process.env.JWT_SECRET = 'test-secret-must-have-at-least-thirty-two-bytes';

const CONTRACT_ID = '11111111-2222-4333-8444-555555555555';
const INVITATION_ID = '22222222-3333-4444-8555-666666666666';
const TARGET_USER_ID = '33333333-4444-4555-8666-777777777777';

const tenantUser = {
  id: '44444444-5555-4666-8777-888888888888',
  fullName: 'Tenant Active',
  role: 'TENANT',
  accountStatus: 'ACTIVE',
};

const landlordUser = {
  id: '55555555-6666-4777-8888-999999999999',
  fullName: 'Landlord Active',
  role: 'LANDLORD',
  accountStatus: 'ACTIVE',
};

const adminUser = {
  id: '66666666-7777-4888-8999-aaaaaaaaaaaa',
  fullName: 'Admin Active',
  role: 'ADMIN',
  accountStatus: 'ACTIVE',
};

const lockedTenantUser = {
  id: '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
  fullName: 'Tenant Locked',
  role: 'TENANT',
  accountStatus: 'LOCKED',
};

const undo: Array<() => void> = [];
afterEach(() => {
  while (undo.length > 0) {
    undo.pop()!();
  }
});

function stub(target: Record<string, any>, key: string, impl: (...args: any[]) => any) {
  const original = target[key];
  target[key] = impl;
  undo.push(() => {
    target[key] = original;
  });
}

async function withServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function authHeaders(userId: string): HeadersInit {
  return {
    Authorization: `Bearer ${signAccessToken(userId)}`,
    'Content-Type': 'application/json',
  };
}

describe('Resident HTTP API Tests', () => {
  test('Thiếu access token trả 401 UNAUTHORIZED trên cả 7 endpoints', async () => {
    await withServer(async (baseUrl) => {
      const requests: Array<[string, string]> = [
        ['GET', `/api/v1/contracts/${CONTRACT_ID}/residents`],
        ['POST', `/api/v1/contracts/${CONTRACT_ID}/invitations`],
        ['GET', '/api/v1/resident-invitations'],
        ['PATCH', `/api/v1/resident-invitations/${INVITATION_ID}/accept`],
        ['PATCH', `/api/v1/resident-invitations/${INVITATION_ID}/reject`],
        ['PATCH', `/api/v1/resident-invitations/${INVITATION_ID}/cancel`],
        ['DELETE', `/api/v1/contracts/${CONTRACT_ID}/residents/${TARGET_USER_ID}`],
      ];

      for (const [method, url] of requests) {
        const res = await fetch(`${baseUrl}${url}`, { method });
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(res.status, 401, `${method} ${url} expected 401, got ${res.status}`);
        assert.equal(body.code, 'UNAUTHORIZED');
      }
    });
  });

  test('Tài khoản LOCKED trả 403 ACCOUNT_LOCKED', async () => {
    stub(prisma.user, 'findUnique', async () => lockedTenantUser);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/resident-invitations`, {
        headers: authHeaders(lockedTenantUser.id),
      });
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 403);
      assert.equal(body.code, 'ACCOUNT_LOCKED');
    });
  });

  test('RBAC: ADMIN bị chặn 403 trên cả 7 endpoints; LANDLORD bị chặn 403 trên inbox/accept/reject', async () => {
    stub(prisma.user, 'findUnique', async ({ where }: any) => {
      if (where.id === adminUser.id) return adminUser;
      if (where.id === landlordUser.id) return landlordUser;
      return null;
    });

    await withServer(async (baseUrl) => {
      const adminCalls: Array<[string, string]> = [
        ['GET', `/api/v1/contracts/${CONTRACT_ID}/residents`],
        ['POST', `/api/v1/contracts/${CONTRACT_ID}/invitations`],
        ['GET', '/api/v1/resident-invitations'],
        ['PATCH', `/api/v1/resident-invitations/${INVITATION_ID}/accept`],
        ['PATCH', `/api/v1/resident-invitations/${INVITATION_ID}/reject`],
        ['PATCH', `/api/v1/resident-invitations/${INVITATION_ID}/cancel`],
        ['DELETE', `/api/v1/contracts/${CONTRACT_ID}/residents/${TARGET_USER_ID}`],
      ];

      for (const [method, url] of adminCalls) {
        const res = await fetch(`${baseUrl}${url}`, {
          method,
          headers: authHeaders(adminUser.id),
        });
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(res.status, 403);
        assert.equal(body.code, 'FORBIDDEN');
      }

      const landlordForbiddenCalls: Array<[string, string]> = [
        ['GET', '/api/v1/resident-invitations'],
        ['PATCH', `/api/v1/resident-invitations/${INVITATION_ID}/accept`],
        ['PATCH', `/api/v1/resident-invitations/${INVITATION_ID}/reject`],
      ];

      for (const [method, url] of landlordForbiddenCalls) {
        const res = await fetch(`${baseUrl}${url}`, {
          method,
          headers: authHeaders(landlordUser.id),
        });
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(res.status, 403);
        assert.equal(body.code, 'FORBIDDEN');
      }
    });
  });

  test('Validation: UUID param sai và body POST /invitations truyền UUID hoặc thiếu identifier trả 400 VALIDATION_ERROR', async () => {
    stub(prisma.user, 'findUnique', async () => tenantUser);

    await withServer(async (baseUrl) => {
      const badUuidCalls: Array<[string, string]> = [
        ['GET', '/api/v1/contracts/bad-uuid/residents'],
        ['PATCH', '/api/v1/resident-invitations/bad-uuid/accept'],
        ['DELETE', `/api/v1/contracts/${CONTRACT_ID}/residents/bad-uuid`],
      ];

      for (const [method, url] of badUuidCalls) {
        const res = await fetch(`${baseUrl}${url}`, {
          method,
          headers: authHeaders(tenantUser.id),
        });
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(res.status, 400);
        assert.equal(body.code, 'VALIDATION_ERROR');
      }

      const badBodies = [
        {},
        { identifier: TARGET_USER_ID },
        { identifier: 'a@b.com', userId: TARGET_USER_ID },
      ];
      for (const payload of badBodies) {
        const res = await fetch(`${baseUrl}/api/v1/contracts/${CONTRACT_ID}/invitations`, {
          method: 'POST',
          headers: authHeaders(tenantUser.id),
          body: JSON.stringify(payload),
        });
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(res.status, 400);
        assert.equal(body.code, 'VALIDATION_ERROR');
      }
    });
  });

  test('Happy paths trên cả 7 endpoints trả đúng HTTP status (201/200) và JSON shape OpenAPI', async () => {
    stub(prisma.user, 'findUnique', async () => tenantUser);

    stub(ResidentService, 'getContractResidents', async () => ({
      contractId: CONTRACT_ID,
      contractStatus: 'ACTIVE',
      room: {
        id: '88888888-9999-4aaa-8bbb-cccccccccccc',
        roomCode: 'P.201',
        maxOccupants: 3,
        property: { id: '99999999-aaaa-4bbb-8ccc-dddddddddddd', name: 'Hoa Mai' },
      },
      currentOccupants: 1,
      maxOccupants: 3,
      remainingSlots: 2,
      residents: [
        {
          userId: tenantUser.id,
          fullName: tenantUser.fullName,
          avatarUrl: null,
          residentRole: 'PRIMARY_TENANT',
          joinedAt: '2026-11-01T08:00:00.000Z',
        },
      ],
      pendingInvitations: [],
    }));

    stub(ResidentService, 'createInvitation', async () => ({
      invitationId: INVITATION_ID,
      contractId: CONTRACT_ID,
      status: 'PENDING',
      expiresAt: '2026-11-25T12:00:00.000Z',
      invitedUser: { id: TARGET_USER_ID, fullName: 'Target', avatarUrl: null },
      invitedBy: { id: tenantUser.id, fullName: tenantUser.fullName, avatarUrl: null },
    }));

    stub(ResidentService, 'listMyInvitations', async () => ({
      items: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    }));

    stub(ResidentService, 'acceptInvitation', async () => ({
      invitationId: INVITATION_ID,
      contractId: CONTRACT_ID,
      status: 'ACCEPTED',
      acceptedAt: '2026-11-22T12:15:00.000Z',
      resident: {
        userId: tenantUser.id,
        fullName: tenantUser.fullName,
        avatarUrl: null,
        residentRole: 'CO_RESIDENT',
        joinedAt: '2026-11-22T12:15:00.000Z',
      },
      currentOccupants: 2,
      maxOccupants: 3,
    }));

    stub(ResidentService, 'rejectInvitation', async () => ({
      invitationId: INVITATION_ID,
      contractId: CONTRACT_ID,
      status: 'REJECTED',
    }));

    stub(ResidentService, 'cancelInvitation', async () => ({
      invitationId: INVITATION_ID,
      contractId: CONTRACT_ID,
      status: 'CANCELLED',
    }));

    stub(ResidentService, 'removeResident', async () => ({
      contractId: CONTRACT_ID,
      userId: TARGET_USER_ID,
      leftAt: '2026-11-22T12:30:00.000Z',
      removalType: 'REMOVED_BY_PRIMARY_TENANT',
      currentOccupants: 1,
      maxOccupants: 3,
    }));

    await withServer(async (baseUrl) => {
      const r1 = await fetch(`${baseUrl}/api/v1/contracts/${CONTRACT_ID}/residents`, {
        headers: authHeaders(tenantUser.id),
      });
      assert.equal(r1.status, 200);
      assert.equal(((await r1.json()) as any).currentOccupants, 1);

      const r2 = await fetch(`${baseUrl}/api/v1/contracts/${CONTRACT_ID}/invitations`, {
        method: 'POST',
        headers: authHeaders(tenantUser.id),
        body: JSON.stringify({ identifier: '0901234567' }),
      });
      assert.equal(r2.status, 201);
      assert.equal(((await r2.json()) as any).status, 'PENDING');

      const r3 = await fetch(`${baseUrl}/api/v1/resident-invitations?page=1&limit=10`, {
        headers: authHeaders(tenantUser.id),
      });
      assert.equal(r3.status, 200);
      assert.deepEqual(((await r3.json()) as any).items, []);

      const r4 = await fetch(`${baseUrl}/api/v1/resident-invitations/${INVITATION_ID}/accept`, {
        method: 'PATCH',
        headers: authHeaders(tenantUser.id),
      });
      assert.equal(r4.status, 200);
      assert.equal(((await r4.json()) as any).status, 'ACCEPTED');

      const r5 = await fetch(`${baseUrl}/api/v1/resident-invitations/${INVITATION_ID}/reject`, {
        method: 'PATCH',
        headers: authHeaders(tenantUser.id),
      });
      assert.equal(r5.status, 200);
      assert.equal(((await r5.json()) as any).status, 'REJECTED');

      const r6 = await fetch(`${baseUrl}/api/v1/resident-invitations/${INVITATION_ID}/cancel`, {
        method: 'PATCH',
        headers: authHeaders(tenantUser.id),
      });
      assert.equal(r6.status, 200);
      assert.equal(((await r6.json()) as any).status, 'CANCELLED');

      const r7 = await fetch(
        `${baseUrl}/api/v1/contracts/${CONTRACT_ID}/residents/${TARGET_USER_ID}`,
        {
          method: 'DELETE',
          headers: authHeaders(tenantUser.id),
        },
      );
      assert.equal(r7.status, 200);
      assert.equal(((await r7.json()) as any).removalType, 'REMOVED_BY_PRIMARY_TENANT');
    });
  });
});
