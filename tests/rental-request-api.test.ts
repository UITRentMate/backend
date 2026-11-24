import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, test } from 'node:test';
import express from 'express';
import { errorHandler } from '../src/common/middleware/error-handler';
import { prisma } from '../src/infrastructure/database/prisma';
import { signAccessToken } from '../src/modules/auth/auth.security';
import { rentalRequestRouter } from '../src/modules/rental-requests/rental-request.routes';

process.env.JWT_SECRET = 'test-secret-must-have-at-least-thirty-two-bytes';

const undo: Array<() => void> = [];
afterEach(() => {
  while (undo.length) undo.pop()!();
});

function stub(delegate: any, name: string, implementation: (...args: any[]) => any) {
  const original = delegate[name];
  delegate[name] = implementation;
  undo.push(() => { delegate[name] = original; });
}

const tenant = {
  id: '550e8400-e29b-41d4-a716-446655440001',
  fullName: 'Test Tenant',
  role: 'TENANT',
  accountStatus: 'ACTIVE',
};
const landlord = {
  id: '550e8400-e29b-41d4-a716-446655440002',
  fullName: 'Test Landlord',
  role: 'LANDLORD',
  accountStatus: 'ACTIVE',
};
const roomId = '550e8400-e29b-41d4-a716-446655440010';
const requestId = '550e8400-e29b-41d4-a716-446655440020';

async function withApi<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use(rentalRequestRouter);
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function auth(userId: string): HeadersInit {
  return { Authorization: `Bearer ${signAccessToken(userId)}` };
}

test('POST without authentication returns 401 UNAUTHORIZED', async () => {
  await withApi(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/rental-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, desiredMoveInDate: '2026-12-01' }),
    });
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 401);
    assert.equal(body.code, 'UNAUTHORIZED');
  });
});

test('POST creates a PENDING request for an authenticated tenant', async () => {
  stub(prisma.user, 'findUnique', async () => tenant);
  stub(prisma.contract, 'findMany', async () => []);
  stub(prisma, '$transaction', async (work: (tx: any) => Promise<unknown>) => work({
    $queryRaw: async () => [],
    room: { findFirst: async ({ where }: any) => where.id === roomId ? { id: roomId } : null },
    rentalRequest: {
      findFirst: async () => null,
      create: async ({ data }: any) => ({
        id: requestId,
        roomId: data.roomId,
        tenantId: data.tenantId,
        desiredStartDate: data.desiredStartDate,
        durationMonths: data.durationMonths,
        message: data.message,
        status: data.status,
        rejectionReason: null,
        reviewedAt: null,
        createdAt: new Date('2026-11-15T00:00:00.000Z'),
      }),
    },
  }));

  await withApi(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/rental-requests`, {
      method: 'POST',
      headers: { ...auth(tenant.id), 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, desiredMoveInDate: '2026-12-01', durationMonths: 12 }),
    });
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 201);
    assert.equal(body.status, 'PENDING');
    assert.equal(body.desiredMoveInDate, '2026-12-01');
  });
});

test('POST maps a concurrent duplicate insert to 409 DUPLICATE_RENTAL_REQUEST', async () => {
  stub(prisma.user, 'findUnique', async () => tenant);
  stub(prisma.contract, 'findMany', async () => []);
  stub(prisma, '$transaction', async () => { throw { code: 'P2002' }; });

  await withApi(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/rental-requests`, {
      method: 'POST',
      headers: { ...auth(tenant.id), 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, desiredMoveInDate: '2026-12-01' }),
    });
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 409);
    assert.equal(body.code, 'DUPLICATE_RENTAL_REQUEST');
  });
});

test('GET detail returns scoped 404 for a request owned by another tenant', async () => {
  stub(prisma.user, 'findUnique', async () => tenant);
  stub(prisma.rentalRequest, 'findFirst', async ({ where }: any) => {
    assert.equal(where.id, requestId);
    assert.equal(where.tenantId, tenant.id);
    return null;
  });

  await withApi(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/rental-requests/${requestId}`, { headers: auth(tenant.id) });
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 404);
    assert.equal(body.code, 'RENTAL_REQUEST_NOT_FOUND');
  });
});

test('PATCH reject returns 409 when the request is no longer PENDING', async () => {
  stub(prisma.user, 'findUnique', async () => landlord);
  stub(prisma.rentalRequest, 'updateMany', async () => ({ count: 0 }));
  stub(prisma.rentalRequest, 'findFirst', async ({ where }: any) => {
    assert.equal(where.id, requestId);
    assert.equal(where.room.property.landlordId, landlord.id);
    return { id: requestId, status: 'REJECTED', rejectionReason: 'Already rejected', reviewedAt: new Date() };
  });

  await withApi(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/rental-requests/${requestId}/reject`, {
      method: 'PATCH',
      headers: { ...auth(landlord.id), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Not suitable' }),
    });
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 409);
    assert.equal(body.code, 'INVALID_STATUS_TRANSITION');
  });
});
