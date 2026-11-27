import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { Prisma } from '@prisma/client';

import { app } from '../../src/app';
import { PHASE3_TIME_LIMITS_MS } from '../../src/common/constants/phase3-status';
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
  await expect('/contracts/bad-id/deposit-receipts', { method: 'POST' }, 400, 'VALIDATION_ERROR');
  await expect(post, { method: 'POST', body: proofForm(signature, 'image/png', 'proof', '1'.repeat(17)) },
    400, 'VALIDATION_ERROR');
  const extraField = proofForm(signature);
  extraField.set('proofUrl', 'https://example.test');
  await expect(post, { method: 'POST', body: extraField }, 400, 'VALIDATION_ERROR');
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

test('HTTP: nghiệp vụ biên nhận chạy được với Prisma và Cloudinary mock', async (t) => {
  const tenantId = '550e8400-e29b-41d4-a716-446655440001';
  const landlordId = '550e8400-e29b-41d4-a716-446655440002';
  const contractId = '550e8400-e29b-41d4-a716-446655440003';
  const receiptId = '550e8400-e29b-41d4-a716-446655440004';
  const uploaded = { publicId: 'receipt-proof', secureUrl: 'https://example.test/receipt-proof' };
  const now = new Date('2026-11-27T08:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  process.env.JWT_SECRET = 'test-secret-must-have-at-least-thirty-two-bytes';
  let allowed = true;
  let cleanupExpiryError = false;
  let failExpiryLookup = false;
  let uploadError = false;
  let txError: Error | undefined;
  const notifications: Prisma.NotificationUncheckedCreateInput[] = [];
  const audits: Prisma.AuditLogUncheckedCreateInput[] = [];
  const contractUpdates: Prisma.ContractUpdateArgs['data'][] = [];
  const longDeadline = new Date(now.getTime() + 86400000);
  const expiry = new Date(now.getTime() + PHASE3_TIME_LIMITS_MS.DEPOSIT_REJECT_GRACE_MS);
  const contract = {
    tenantId, status: 'AWAITING_DEPOSIT', depositSnapshot: new Prisma.Decimal('200.00'),
    depositDeadlineAt: longDeadline as Date | null, room: { property: { landlordId } },
    depositReceipts: [] as { id: string }[],
  };
  const receipt = {
    id: receiptId, contractId, status: 'PENDING', amount: new Prisma.Decimal('200.00'),
    proofUrl: uploaded.secureUrl, submittedAt: now, confirmedAt: null, confirmedById: null, rejectionReason: null,
  };

  function replace<T extends object, K extends keyof T>(ctx: TestContext, target: T, key: K, value: unknown) {
    const original = target[key];
    target[key] = value as T[K];
    ctx.after(() => { target[key] = original; });
  }
  replace(t, prisma.user, 'findUnique', async ({ where: { id } }: Prisma.UserFindUniqueArgs) => ({
    id, role: id === tenantId ? 'TENANT' : 'LANDLORD', accountStatus: 'ACTIVE', fullName: 'Test',
  }));
  replace(t, prisma.contract, 'findMany', async () => {
    if (failExpiryLookup) throw new Error('DB unavailable');
    return [];
  });
  replace(t, prisma.contract, 'findFirst', async ({ select }: Prisma.ContractFindFirstArgs) => {
    if (!allowed) return null;
    if (select?.depositReceipts && typeof select.depositReceipts === 'object' && select.depositReceipts.orderBy) {
      return { depositReceipts: [receipt] };
    }
    return contract;
  });
  const tx = {
    $queryRaw: async () => [],
    contract: {
      findFirst: async () => contract,
      update: async ({ data }: Prisma.ContractUpdateArgs) => { contractUpdates.push(data); },
    },
    depositReceipt: {
      create: async () => receipt,
      findFirst: async () => allowed ? { ...receipt, contract } : null,
      update: async ({ data }: Prisma.DepositReceiptUpdateArgs) => ({ ...receipt, ...data }),
    },
    notification: { create: async ({ data }: { data: Prisma.NotificationUncheckedCreateInput }) => notifications.push(data) },
    auditLog: { create: async ({ data }: { data: Prisma.AuditLogUncheckedCreateInput }) => audits.push(data) },
  };
  replace(t, prisma, '$transaction', async (work: (client: typeof tx) => Promise<unknown>) => {
    if (txError) throw txError;
    if (cleanupExpiryError) {
      contract.depositDeadlineAt = now;
      failExpiryLookup = true;
    }
    return work(tx);
  });
  const remove = t.mock.method(mediaService, 'deleteResource', async () => true);
  t.mock.method(mediaService, 'uploadStream', async () => {
    if (uploadError) throw { http_code: 503, message: 'credential-must-not-be-logged' };
    return uploaded;
  });
  const errorLog = t.mock.method(console, 'error', () => {});
  const warningLog = t.mock.method(console, 'warn', () => {});
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const contractPath = `/contracts/${contractId}/deposit-receipts`;

  async function request<T>(path: string, userId: string, status: number, init: RequestInit = {}) {
    const response = await fetch(base + path, {
      ...init, headers: { Authorization: `Bearer ${signAccessToken(userId)}`, ...init.headers },
    });
    const body = await response.json() as T & { code?: string };
    assert.equal(response.status, status, JSON.stringify(body));
    return body;
  }
  function submit<T>(status: number, amount = '200.00') {
    const form = new FormData();
    form.set('amount', amount);
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    form.set('proof', new Blob([png], { type: 'image/png' }), 'proof.png');
    return request<T>(contractPath, tenantId, status, { method: 'POST', body: form });
  }
  function review(action: 'confirm' | 'reject', status: number) {
    return request<{ receipt: { status: string }; contractStatus: string; depositDeadlineAt: string }>(
      `/deposit-receipts/${receiptId}/${action}`, landlordId, status, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: action === 'reject' ? JSON.stringify({ rejectionReason: 'Chưa nhận đủ tiền' }) : undefined,
      },
    );
  }

  assert.equal((await submit<{ amount: string }>(201)).amount, '200.00');
  assert.equal(notifications[0].eventType, 'DEPOSIT_RECEIPT_SUBMITTED');
  for (const actor of [tenantId, landlordId]) {
    const history = await request<{ items: { id: string }[] }>(contractPath, actor, 200);
    assert.equal(history.items[0].id, receiptId);
  }
  assert.equal((await submit(400, '199.99')).code, 'INSUFFICIENT_DEPOSIT_AMOUNT');
  contract.status = 'DRAFT';
  assert.equal((await submit(409)).code, 'INVALID_CONTRACT_STATUS');
  assert.equal((await review('confirm', 409)).code, 'INVALID_CONTRACT_STATUS');
  contract.status = 'AWAITING_DEPOSIT';
  contract.depositDeadlineAt = now;
  assert.equal((await submit(409)).code, 'DEPOSIT_DEADLINE_EXPIRED');
  contract.depositDeadlineAt = longDeadline;
  contract.depositReceipts = [{ id: receiptId }];
  assert.equal((await submit(409)).code, 'DEPOSIT_RECEIPT_ALREADY_PENDING');
  contract.depositReceipts = [];
  allowed = false;
  assert.equal((await review('reject', 404)).code, 'NOT_FOUND');
  allowed = true;
  assert.equal((await review('confirm', 200)).contractStatus, 'DEPOSIT_CONFIRMED');
  assert.equal(contractUpdates.at(-1)?.status, 'DEPOSIT_CONFIRMED');
  assert.equal(audits.at(-1)?.action, 'DEPOSIT_CONFIRMED');
  assert.equal(notifications.at(-1)?.eventType, 'DEPOSIT_CONFIRMED');
  receipt.status = 'CONFIRMED';
  assert.equal((await review('confirm', 409)).code, 'INVALID_DEPOSIT_RECEIPT_STATUS');
  receipt.status = 'PENDING';
  const updatesAfterConfirm = contractUpdates.length;
  assert.equal((await review('reject', 200)).depositDeadlineAt, longDeadline.toISOString());
  assert.equal(contractUpdates.length, updatesAfterConfirm);
  for (const deadline of [new Date(now.getTime() + 60000), now, null]) {
    contract.depositDeadlineAt = deadline;
    const rejected = await review('reject', 200);
    assert.equal(rejected.receipt.status, 'REJECTED');
    assert.equal(rejected.depositDeadlineAt, expiry.toISOString());
    assert.deepEqual(contractUpdates.at(-1)?.depositDeadlineAt, expiry);
  }
  assert.equal(audits.at(-1)?.action, 'DEPOSIT_REJECTED');
  assert.equal(notifications.at(-1)?.eventType, 'DEPOSIT_REJECTED');

  contract.depositDeadlineAt = longDeadline;
  uploadError = true;
  assert.equal((await submit(502)).code, 'CLOUDINARY_UPLOAD_FAILED');
  assert.equal(errorLog.mock.callCount(), 1);
  assert.doesNotMatch(JSON.stringify(errorLog.mock.calls[0].arguments), /credential-must-not-be-logged/);
  uploadError = false;
  txError = new Error('DB write failure');
  assert.equal((await submit(500)).code, 'INTERNAL_ERROR');
  assert.equal(remove.mock.callCount(), 1);
  txError = undefined;
  cleanupExpiryError = true;
  assert.equal((await submit(409)).code, 'DEPOSIT_DEADLINE_EXPIRED');
  assert.equal(remove.mock.callCount(), 2);
  assert.equal(warningLog.mock.callCount(), 1);
});
