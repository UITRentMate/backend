import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { app } from '../src/app';
import { prisma } from '../src/infrastructure/database/prisma';
import { signAccessToken } from '../src/modules/auth/auth.security';

test('Các API giữ chỗ kiểm tra quyền và dữ liệu đầu vào', async (t) => {
  const userId = '550e8400-e29b-41d4-a716-446655440001';
  const pathId = '550e8400-e29b-41d4-a716-446655440002';
  process.env.JWT_SECRET = 'test-secret-must-have-at-least-thirty-two-bytes';
  let role = 'TENANT';
  const originalFindUnique = prisma.user.findUnique;
  prisma.user.findUnique = (async () => ({
    id: userId, role, accountStatus: 'ACTIVE', fullName: 'Test',
  })) as typeof prisma.user.findUnique;
  t.after(() => { prisma.user.findUnique = originalFindUnique; });
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api/v1';
  const headers = { Authorization: 'Bearer ' + signAccessToken(userId), 'Content-Type': 'application/json' };

  const unauthorized = await fetch(base + '/contracts/' + pathId + '/cancel-hold', { method: 'PATCH' });
  assert.equal(unauthorized.status, 401);
  const forbidden = await fetch(base + '/rental-requests/' + pathId + '/approve', { method: 'PATCH', headers });
  assert.equal(forbidden.status, 403);

  const invalidReason = await fetch(base + '/contracts/' + pathId + '/cancel-hold', {
    method: 'PATCH', headers, body: JSON.stringify({ reason: '   ngắn   ' }),
  });
  assert.equal(invalidReason.status, 400);
  assert.equal((await invalidReason.json()).code, 'VALIDATION_ERROR');

  role = 'LANDLORD';
  const invalidId = await fetch(base + '/rental-requests/bad-id/approve', { method: 'PATCH', headers });
  assert.equal(invalidId.status, 400);
  assert.equal((await invalidId.json()).code, 'VALIDATION_ERROR');
});
