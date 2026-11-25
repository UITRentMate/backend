import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { app } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { signAccessToken } from '../../src/modules/auth/auth.security';
import { mediaService } from '../../src/modules/media/media.service';

test('HTTP: bảo vệ endpoint và chỉ nhận một ảnh proof hợp lệ', async (t) => {
  const userId = '550e8400-e29b-41d4-a716-446655440001';
  const id = '550e8400-e29b-41d4-a716-446655440002';
  process.env.JWT_SECRET = 'test-secret-must-have-at-least-thirty-two-bytes';
  let role = 'TENANT';
  let accountStatus = 'ACTIVE';
  const findUser = prisma.user.findUnique;
  prisma.user.findUnique = (async () => ({ id: userId, role, accountStatus, fullName: 'Test' })) as unknown as typeof findUser;
  t.after(() => { prisma.user.findUnique = findUser; });
  const findContract = prisma.contract.findFirst;
  prisma.contract.findFirst = (async () => null) as typeof findContract;
  t.after(() => { prisma.contract.findFirst = findContract; });
  const upload = t.mock.method(mediaService, 'uploadStream', async () => assert.fail('Không được upload khi input sai'));
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const post = `/contracts/${id}/deposit-receipts`;
  const review = `/deposit-receipts/${id}`;
  const auth = { Authorization: `Bearer ${signAccessToken(userId)}` };

  async function expect(path: string, init: RequestInit, status: number, code: string, authenticated = true) {
    const response = await fetch(base + path, { ...init, headers: { ...(authenticated && auth), ...init.headers } });
    assert.equal(response.status, status);
    assert.equal((await response.json() as { code: string }).code, code);
  }

  await expect(post, { method: 'POST' }, 401, 'UNAUTHORIZED', false);
  await expect(review + '/confirm', { method: 'PATCH' }, 403, 'FORBIDDEN');
  accountStatus = 'LOCKED';
  await expect(post, {}, 403, 'ACCOUNT_LOCKED');
  accountStatus = 'ACTIVE';
  await expect('/contracts/bad-id/deposit-receipts', {}, 400, 'VALIDATION_ERROR');
  await expect(post, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: '42', proofUrl: 'https://example.test' }) }, 400, 'FILE_REQUIRED');
  await expect(post, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data' }, body: 'bad' },
    400, 'INVALID_FILE_UPLOAD');

  function proofForm(bytes?: Uint8Array<ArrayBuffer>, mime = 'image/png', field = 'proof', amount = '42') {
    const form = new FormData();
    form.set('amount', amount);
    if (bytes) form.set(field, new Blob([bytes], { type: mime }), 'proof.png');
    return form;
  }
  const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  await expect(post, { method: 'POST', body: proofForm() }, 400, 'FILE_REQUIRED');
  await expect(post, { method: 'POST', body: proofForm(Uint8Array.of(1, 2, 3)) }, 400, 'INVALID_FILE_UPLOAD');
  await expect(post, { method: 'POST', body: proofForm(signature, 'image/jpeg') }, 400, 'INVALID_FILE_UPLOAD');
  await expect(post, { method: 'POST', body: proofForm(signature, 'image/png', 'other') }, 400, 'INVALID_FILE_UPLOAD');
  await expect(post, { method: 'POST', body: proofForm(signature, 'image/png', 'proof', '0') }, 400, 'VALIDATION_ERROR');
  const tooLarge = new Uint8Array(5 * 1024 * 1024 + 1);
  tooLarge.set(signature);
  await expect(post, { method: 'POST', body: proofForm(tooLarge) }, 413, 'FILE_TOO_LARGE');
  await expect(post, { method: 'POST', body: proofForm(tooLarge.subarray(0, -1)) }, 404, 'NOT_FOUND');

  role = 'LANDLORD';
  await expect(post, { method: 'POST', body: proofForm(signature) }, 403, 'FORBIDDEN');
  await expect(review + '/reject', { method: 'PATCH' }, 400, 'VALIDATION_ERROR');
  assert.equal(upload.mock.callCount(), 0);
});
