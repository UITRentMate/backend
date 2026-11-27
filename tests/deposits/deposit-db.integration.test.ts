import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';

import { app } from '../../src/app';
import { PHASE3_TIME_LIMITS_MS } from '../../src/common/constants/phase3-status';
import { prisma } from '../../src/infrastructure/database/prisma';
import { signAccessToken } from '../../src/modules/auth/auth.security';
import { createPendingReceipt } from '../../src/modules/deposits/deposit.repository';
import { mediaService } from '../../src/modules/media/media.service';

const isolatedDb = Boolean(process.env.RENTMATE_DEPOSIT_TEST_DATABASE_URL)
  && process.env.DATABASE_URL === process.env.RENTMATE_DEPOSIT_TEST_DATABASE_URL;

type ReceiptResponse = {
  id: string;
  amount: string;
  proofUrl: string;
  status: string;
  confirmedAt: string | null;
  confirmedById: string | null;
  rejectionReason: string | null;
};

type ReviewResponse = { receipt: ReceiptResponse; contractStatus: string; depositDeadlineAt: string | null };

test('PostgreSQL: đối soát cọc, lịch sử, race và hết hạn', {
  skip: isolatedDb ? false : 'Cần DB test riêng đã migrate với DATABASE_URL = RENTMATE_DEPOSIT_TEST_DATABASE_URL',
}, async (t) => {
  process.env.JWT_SECRET = 'test-secret-must-have-at-least-thirty-two-bytes';
  const users = await Promise.all(['LANDLORD', 'LANDLORD', 'TENANT', 'TENANT'].map((role) =>
    prisma.user.create({ data: {
      fullName: role, email: `${randomUUID()}@rentmate.test`, phone: randomUUID().slice(0, 8),
      passwordHash: 'test-only', role, accountStatus: 'ACTIVE',
    } })));
  const [landlord, otherLandlord, tenant, otherTenant] = users;
  const property = await prisma.property.create({ data: {
    landlordId: landlord.id, name: 'Deposit test', address: 'Test address', status: 'ACTIVE',
  } });
  const rooms: string[] = [];
  const contracts: string[] = [];
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const userIds = users.map(({ id }) => id);
    const receipts = await prisma.depositReceipt.findMany({ where: { contractId: { in: contracts } }, select: { id: true } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...contracts, ...receipts.map(({ id }) => id)] } } });
    await prisma.notification.deleteMany({ where: { recipientId: { in: userIds } } });
    await prisma.depositReceipt.deleteMany({ where: { contractId: { in: contracts } } });
    await prisma.contract.deleteMany({ where: { id: { in: contracts } } });
    await prisma.room.deleteMany({ where: { id: { in: rooms } } });
    await prisma.property.delete({ where: { id: property.id } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  async function createContract(depositDeadlineAt = new Date(Date.now() + 14 * 86400000), status = 'AWAITING_DEPOSIT') {
    const room = await prisma.room.create({ data: {
      propertyId: property.id, roomCode: `DEP-${randomUUID().slice(0, 8)}`, areaM2: 20, maxOccupants: 2,
      monthlyRent: 1000000, depositRequired: 2000000, electricityRate: 1500, waterRate: 2000,
      occupancyStatus: 'HELD', visibilityStatus: 'VISIBLE',
    } });
    rooms.push(room.id);
    const contract = await prisma.contract.create({ data: {
      roomId: room.id, tenantId: tenant.id, status, depositDeadlineAt,
      startDate: new Date('2028-01-01'), endDate: new Date('2028-07-01'),
      rentSnapshot: 1000000, depositSnapshot: 2000000, electricityRate: 1500, waterRate: 2000,
    } });
    contracts.push(contract.id);
    return contract;
  }

  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const path = (id: string) => `/contracts/${id}/deposit-receipts`;
  async function api<T = unknown>(url: string, userId: string, init: RequestInit = {}) {
    const response = await fetch(base + url, {
      ...init, headers: { Authorization: `Bearer ${signAccessToken(userId)}`, ...init.headers },
      signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, body: await response.json() as T & { code?: string } };
  }
  function submit(id: string, userId = tenant.id, amount = '2000000.00') {
    const form = new FormData();
    form.set('amount', amount);
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    form.set('proof', new Blob([png], { type: 'image/png' }), 'proof.png');
    return api<ReceiptResponse>(path(id), userId, { method: 'POST', body: form });
  }
  function review(receiptId: string, action: string, userId = landlord.id, rejectionReason?: string) {
    return api<ReviewResponse>(`/deposit-receipts/${receiptId}/${action}`, userId, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: rejectionReason === undefined ? undefined : JSON.stringify({ rejectionReason }),
    });
  }

  const cleaned: string[] = [];
  const upload = t.mock.method(mediaService, 'uploadStream', async (_proof: Buffer, options: { folder: string; publicId: string }) => ({
    publicId: `${options.folder}/${options.publicId}`,
    secureUrl: `https://res.cloudinary.com/test/image/upload/${options.folder}/${options.publicId}.png`,
  }));
  t.mock.method(mediaService, 'deleteResource', async (publicId: string) => {
    cleaned.push(publicId);
    return true;
  });

  await t.test('kiểm tra quyền và hạn trước upload, rồi giải phóng phòng quá hạn', async () => {
    const expired = await createContract(new Date(Date.now() - 60000));
    const draft = await createContract(undefined, 'DRAFT');
    const eligible = await createContract();
    assert.equal((await submit(expired.id, otherTenant.id)).body.code, 'NOT_FOUND');
    assert.equal((await prisma.contract.findUniqueOrThrow({ where: { id: expired.id } })).status, 'AWAITING_DEPOSIT');
    assert.deepEqual(await api(path(eligible.id), tenant.id), { status: 200, body: { items: [] } });
    assert.equal((await api(path(eligible.id), otherTenant.id)).status, 404);
    assert.equal((await api(path(eligible.id), otherLandlord.id)).status, 404);
    assert.equal((await submit(draft.id)).body.code, 'INVALID_CONTRACT_STATUS');
    assert.equal((await submit(eligible.id, tenant.id, '1999999.99')).body.code, 'INSUFFICIENT_DEPOSIT_AMOUNT');
    const late = await submit(expired.id);
    assert.equal(late.status, 409);
    assert.equal(late.body.code, 'DEPOSIT_DEADLINE_EXPIRED');
    assert.equal((await prisma.contract.findUniqueOrThrow({ where: { id: expired.id } })).status, 'EXPIRED');
    assert.equal((await prisma.room.findUniqueOrThrow({ where: { id: expired.roomId } })).occupancyStatus, 'VACANT');
    assert.equal(upload.mock.callCount(), 0);
  });

  await t.test('chỉ một lượt nộp và một lượt xác nhận thành công', async () => {
    const contract = await createContract();
    const originalUpload = mediaService.uploadStream;
    const { promise, resolve } = Promise.withResolvers<void>();
    let uploadsStarted = 0;
    const racingUpload = t.mock.method(mediaService, 'uploadStream', async (...args: Parameters<typeof originalUpload>) => {
      if (++uploadsStarted === 2) resolve();
      await promise;
      return originalUpload(...args);
    });
    const submissions = await Promise.all([submit(contract.id), submit(contract.id)]);
    racingUpload.mock.restore();
    assert.deepEqual(submissions.map(({ status }) => status).sort(), [201, 409]);
    assert.equal(submissions.find(({ status }) => status === 409)?.body.code, 'DEPOSIT_RECEIPT_ALREADY_PENDING');
    const receipt = submissions.find(({ status }) => status === 201)!.body;
    assert.equal(receipt.amount, '2000000.00');
    assert.equal(receipt.status, 'PENDING');
    assert.match(receipt.proofUrl, new RegExp(`/rentmate/deposits/${contract.id}/`));
    assert.equal(cleaned.length, 1);
    assert.ok(!receipt.proofUrl.includes(cleaned[0]));
    assert.equal(await prisma.depositReceipt.count({ where: { contractId: contract.id } }), 1);
    assert.equal(await prisma.notification.count({ where: { recipientId: landlord.id, eventType: 'DEPOSIT_RECEIPT_SUBMITTED' } }), 1);
    await assert.rejects(prisma.$transaction((tx) =>
      createPendingReceipt(tx, contract.id, new Prisma.Decimal('2000000'), 'https://example.test/duplicate')),
    { code: 'DEPOSIT_RECEIPT_ALREADY_PENDING' });

    assert.equal((await review(receipt.id, 'confirm', otherLandlord.id)).status, 404);
    const confirms = await Promise.all([review(receipt.id, 'confirm'), review(receipt.id, 'confirm')]);
    assert.deepEqual(confirms.map(({ status }) => status).sort(), [200, 409]);
    const confirmed = confirms.find(({ status }) => status === 200)!.body;
    assert.equal(confirmed.contractStatus, 'DEPOSIT_CONFIRMED');
    assert.equal(confirmed.receipt.status, 'CONFIRMED');
    assert.equal(confirmed.receipt.confirmedById, landlord.id);
    assert.ok(confirmed.receipt.confirmedAt);
    assert.equal((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status, 'DEPOSIT_CONFIRMED');
    assert.equal((await prisma.room.findUniqueOrThrow({ where: { id: contract.roomId } })).occupancyStatus, 'HELD');
    const audits = await prisma.auditLog.findMany({ where: { entityId: receipt.id, action: 'DEPOSIT_CONFIRMED' } });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actorId, landlord.id);
    assert.deepEqual(audits[0].newData, {
      contractId: contract.id, amount: '2000000.00', proofUrl: receipt.proofUrl, oldStatus: 'PENDING', newStatus: 'CONFIRMED',
      contractStatus: 'DEPOSIT_CONFIRMED', depositDeadlineAt: contract.depositDeadlineAt!.toISOString(), rejectionReason: null,
    });
    assert.equal(await prisma.notification.count({ where: { recipientId: tenant.id, eventType: 'DEPOSIT_CONFIRMED' } }), 1);
  });

  await t.test('đóng băng hạn khi chờ, gia hạn sau từ chối và giữ lịch sử nộp lại', async () => {
    const contract = await createContract();
    const initial = await submit(contract.id);
    assert.equal(initial.status, 201);
    const first = initial.body;
    await prisma.contract.update({ where: { id: contract.id }, data: { depositDeadlineAt: new Date(Date.now() - 60000) } });
    assert.equal((await submit(contract.id)).body.code, 'DEPOSIT_RECEIPT_ALREADY_PENDING');
    assert.equal((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status, 'AWAITING_DEPOSIT');
    assert.equal((await review(first.id, 'reject')).status, 400);
    const reason = 'Số tiền chuyển khoản chưa khớp';
    const rejected = await review(first.id, 'reject', landlord.id, reason);
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.contractStatus, 'AWAITING_DEPOSIT');
    assert.equal(rejected.body.receipt.rejectionReason, reason);
    assert.ok(rejected.body.depositDeadlineAt && rejected.body.receipt.confirmedAt);
    assert.equal(Date.parse(rejected.body.depositDeadlineAt) - Date.parse(rejected.body.receipt.confirmedAt),
      PHASE3_TIME_LIMITS_MS.DEPOSIT_REJECT_GRACE_MS);
    const notification = await prisma.notification.findFirstOrThrow({ where: { recipientId: tenant.id, eventType: 'DEPOSIT_REJECTED' } });
    assert.deepEqual(notification.payload, {
      content: reason, actionUrl: `/contracts/${contract.id}`, relatedEntityType: 'DEPOSIT_RECEIPT', relatedEntityId: first.id,
    });
    assert.equal(await prisma.auditLog.count({ where: { entityId: first.id, action: 'DEPOSIT_REJECTED' } }), 1);
    const replacement = await submit(contract.id);
    assert.equal(replacement.status, 201);
    const { status, body } = await api<{ items: ReceiptResponse[] }>(path(contract.id), landlord.id);
    assert.equal(status, 200);
    assert.deepEqual(body.items.map(({ id, status }) => [id, status]),
      [[replacement.body.id, 'PENDING'], [first.id, 'REJECTED']]);
    const earlyRejection = await review(replacement.body.id, 'reject', landlord.id, reason);
    assert.ok(earlyRejection.body.depositDeadlineAt && earlyRejection.body.receipt.confirmedAt);
    assert.equal(Date.parse(earlyRejection.body.depositDeadlineAt) - Date.parse(earlyRejection.body.receipt.confirmedAt),
      PHASE3_TIME_LIMITS_MS.DEPOSIT_REJECT_GRACE_MS);
  });

  await t.test('xóa ảnh và commit hết hạn khi thời hạn trôi qua trong lúc upload', async (scenario) => {
    const contract = await createContract();
    const originalUpload = mediaService.uploadStream;
    const delayUpload = scenario.mock.method(mediaService, 'uploadStream', async (...args: Parameters<typeof originalUpload>) => {
      const result = await originalUpload(...args);
      await prisma.contract.update({ where: { id: contract.id }, data: { depositDeadlineAt: new Date() } });
      return result;
    });
    const cleanupCount = cleaned.length;
    const late = await submit(contract.id);
    assert.equal(late.status, 409);
    assert.equal(late.body.code, 'DEPOSIT_DEADLINE_EXPIRED');
    assert.equal(delayUpload.mock.callCount(), 1);
    assert.equal(cleaned.length, cleanupCount + 1);
    assert.ok(cleaned.at(-1)?.startsWith(`rentmate/deposits/${contract.id}/`));
    assert.equal(await prisma.depositReceipt.count({ where: { contractId: contract.id } }), 0);
    assert.equal((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status, 'EXPIRED');
    assert.equal((await prisma.room.findUniqueOrThrow({ where: { id: contract.roomId } })).occupancyStatus, 'VACANT');
  });

  await t.test('rollback biên nhận và thông báo, đồng thời xóa ảnh khi giao dịch thất bại', async () => {
    const contract = await createContract();
    const originalTransaction = prisma.$transaction;
    const recipientEvents = { recipientId: landlord.id, eventType: 'DEPOSIT_RECEIPT_SUBMITTED' };
    const notificationCount = await prisma.notification.count({ where: recipientEvents });
    const cleanupCount = cleaned.length;
    const failedTransaction = async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      originalTransaction.call(prisma, async (tx: Prisma.TransactionClient) => {
        await work(tx);
        throw new Error('Giả lập lỗi trước commit');
      });
    prisma.$transaction = failedTransaction as unknown as typeof originalTransaction;
    try {
      const failed = await submit(contract.id);
      assert.equal(failed.status, 500);
      assert.equal(failed.body.code, 'INTERNAL_ERROR');
    } finally {
      prisma.$transaction = originalTransaction;
    }
    assert.equal(await prisma.depositReceipt.count({ where: { contractId: contract.id } }), 0);
    assert.equal(await prisma.notification.count({ where: recipientEvents }), notificationCount);
    assert.equal(cleaned.length, cleanupCount + 1);
    assert.ok(cleaned.at(-1)?.startsWith(`rentmate/deposits/${contract.id}/`));
  });
});
