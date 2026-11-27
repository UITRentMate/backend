import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { app } from '../src/app';
import { prisma } from '../src/infrastructure/database/prisma';
import { signAccessToken } from '../src/modules/auth/auth.security';

const isolatedDb = Boolean(process.env.RENTMATE_HOLD_TEST_DATABASE_URL)
  && process.env.DATABASE_URL === process.env.RENTMATE_HOLD_TEST_DATABASE_URL;

test('PostgreSQL: duyệt đồng thời, đóng băng giá, hủy và hết hạn giữ chỗ', {
  skip: isolatedDb ? false : 'Cần DATABASE_URL trỏ đến DB test riêng đã migrate và khớp RENTMATE_HOLD_TEST_DATABASE_URL',
}, async (t) => {
  process.env.JWT_SECRET = 'test-secret-must-have-at-least-thirty-two-bytes';
  const users = await Promise.all(['LANDLORD', 'LANDLORD', 'TENANT', 'TENANT', 'TENANT'].map((role) =>
    prisma.user.create({ data: {
      fullName: role, email: randomUUID() + '@rentmate.test', phone: randomUUID().slice(0, 8),
      passwordHash: 'test-only', role, accountStatus: 'ACTIVE',
    } })));
  const [owner, outsider, ...tenants] = users;
  const property = await prisma.property.create({ data: {
    landlordId: owner.id, name: 'Hold test', address: 'Test address', status: 'ACTIVE',
  } });
  const roomCode = 'HOLD-' + randomUUID().slice(0, 8);
  const room = await prisma.room.create({ data: {
    propertyId: property.id, roomCode, areaM2: 20, maxOccupants: 2, monthlyRent: 1000000,
    depositRequired: 2000000, electricityRate: 1500, waterRate: 2000,
    occupancyStatus: 'VACANT', visibilityStatus: 'VISIBLE',
    serviceFees: { create: { feeName: 'Internet', monthlyAmount: 123456.78, isRequired: true } },
  } });
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const contracts = await prisma.contract.findMany({ where: { roomId: room.id }, select: { id: true } });
    const contractIds = contracts.map(({ id }) => id);
    const requests = await prisma.rentalRequest.findMany({ where: { roomId: room.id }, select: { id: true } });
    const requestIds = requests.map(({ id }) => id);
    const userIds = users.map(({ id }) => id);
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...contractIds, ...requestIds] } } });
    await prisma.notification.deleteMany({ where: { recipientId: { in: userIds } } });
    await prisma.depositReceipt.deleteMany({ where: { contractId: { in: contractIds } } });
    await prisma.contractServiceFee.deleteMany({ where: { contractId: { in: contractIds } } });
    await prisma.contract.deleteMany({ where: { roomId: room.id } });
    await prisma.rentalRequest.deleteMany({ where: { roomId: room.id } });
    await prisma.room.delete({ where: { id: room.id } });
    await prisma.property.delete({ where: { id: property.id } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });
  const requests = await Promise.all(tenants.map((tenant) => prisma.rentalRequest.create({ data: {
    roomId: room.id, tenantId: tenant.id, desiredStartDate: new Date('2028-08-31'), status: 'PENDING',
  } })));
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api/v1';
  async function patch(path: string, actorId: string, reason?: string) {
    const response = await fetch(url + path, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + signAccessToken(actorId), 'Content-Type': 'application/json' },
      body: reason === undefined ? undefined : JSON.stringify({ reason }),
    });
    return { status: response.status, body: await response.json() };
  }
  const approve = (id: string, actorId = owner.id) => patch('/rental-requests/' + id + '/approve', actorId);
  const cancel = (id: string, actorId = owner.id) =>
    patch('/contracts/' + id + '/cancel-hold', actorId, 'Thay đổi kế hoạch thuê nhà');

  async function roomIsDiscoverable() {
    const response = await fetch(url + '/rooms/search?keyword=' + roomCode);
    assert.equal(response.status, 200);
    const { items } = await response.json() as { items: Array<{ roomId: string }> };
    return items.some((item) => item.roomId === room.id);
  }

  assert.equal(await roomIsDiscoverable(), true);
  const forbidden = await approve(requests[0].id, outsider.id);
  assert.equal(forbidden.status, 404);
  assert.equal(forbidden.body.code, 'NOT_FOUND');
  const results = await Promise.all(requests.slice(0, 2).map(({ id }) => approve(id)));
  assert.deepEqual(results.map(({ status }) => status).sort(), [200, 409]);
  assert.equal(results.find(({ status }) => status === 409)?.body.code, 'INVALID_RENTAL_REQUEST_STATUS');
  const winner = results.find(({ status }) => status === 200)!.body;
  const drafts = await prisma.contract.findMany({ where: { roomId: room.id }, include: { contractServiceFees: true } });
  assert.equal(drafts.length, 1);
  const [contract] = drafts;
  assert.equal(contract.id, winner.contract.id);
  assert.equal(contract.status, 'DRAFT');
  assert.equal(contract.rentalRequestId, winner.rentalRequestId);
  assert.equal(contract.startDate.toISOString().slice(0, 10), '2028-08-31');
  assert.equal(contract.endDate.toISOString().slice(0, 10), '2029-02-28');
  assert.equal(contract.holdExpiresAt!.getTime() - Date.parse(winner.reviewedAt), 48 * 60 * 60 * 1000);
  assert.deepEqual([contract.rentSnapshot, contract.depositSnapshot, contract.electricityRate, contract.waterRate].map(Number),
    [1000000, 2000000, 1500, 2000]);
  assert.deepEqual(contract.contractServiceFees.map((fee) => [fee.feeName, Number(fee.monthlyAmount)]),
    [['Internet', 123456.78]]);
  const reviewed = await prisma.rentalRequest.findMany({ where: { roomId: room.id } });
  assert.deepEqual(reviewed.map(({ status }) => status).sort(), ['APPROVED', 'REJECTED', 'REJECTED']);
  assert.ok(reviewed.every(({ reviewedAt }) => reviewedAt?.toISOString() === winner.reviewedAt));
  assert.ok(reviewed.filter(({ status }) => status === 'REJECTED').every(({ rejectionReason }) => rejectionReason));
  assert.deepEqual((await prisma.notification.findMany({
    where: { recipientId: { in: tenants.map(({ id }) => id) } },
  })).map(({ eventType }) => eventType).sort(),
  ['RENTAL_REQUEST_APPROVED', 'RENTAL_REQUEST_AUTO_REJECTED', 'RENTAL_REQUEST_AUTO_REJECTED']);
  assert.equal(await prisma.auditLog.count({ where: { entityId: winner.rentalRequestId, action: 'RENTAL_REQUEST_APPROVED' } }), 1);
  assert.equal((await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).occupancyStatus, 'HELD');
  assert.equal(await roomIsDiscoverable(), false);
  assert.equal((await cancel(contract.id, outsider.id)).status, 404);

  await prisma.contract.update({ where: { id: contract.id }, data: { status: 'DEPOSIT_CONFIRMED' } });
  assert.equal((await cancel(contract.id)).body.code, 'CANNOT_CANCEL_AFTER_DEPOSIT_CONFIRMED');

  const deadline = new Date(Date.now() + 72 * 60 * 60 * 1000);
  await prisma.contract.update({ where: { id: contract.id }, data: { status: 'AWAITING_DEPOSIT', depositDeadlineAt: deadline } });
  const receipt = await prisma.depositReceipt.create({ data: {
    contractId: contract.id, amount: 2000000, proofUrl: 'https://example.test/proof', status: 'PENDING',
  } });
  assert.equal((await cancel(contract.id)).body.code, 'PENDING_DEPOSIT_RECEIPT_EXISTS');
  const { expireOverdueHeldContracts, expireHoldForContract, expireHoldForRoom } = await import('../src/modules/contracts/contract.service');
  assert.equal(await expireHoldForContract(contract.id, deadline), false);
  await prisma.depositReceipt.update({ where: { id: receipt.id }, data: { status: 'REJECTED' } });
  assert.equal(await expireHoldForContract(contract.id, new Date(deadline.getTime() - 1)), false);
  assert.equal(await expireOverdueHeldContracts(deadline), 1);
  assert.equal(await expireHoldForContract(contract.id, deadline), false);
  assert.equal((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status, 'EXPIRED');
  assert.equal(await prisma.auditLog.count({ where: { entityId: contract.id, action: 'CONTRACT_HOLD_EXPIRED' } }), 1);
  assert.equal(await prisma.notification.count({ where: {
    recipientId: { in: [owner.id, contract.tenantId] }, eventType: 'CONTRACT_HOLD_EXPIRED',
  } }), 2);

  const newRequest = await prisma.rentalRequest.create({ data: {
    roomId: room.id, tenantId: contract.tenantId, desiredStartDate: new Date('2028-08-31'), status: 'PENDING',
  } });
  const next = await approve(newRequest.id);
  assert.equal(next.status, 200);
  assert.equal(await expireHoldForContract(next.body.contract.id, new Date(Date.parse(next.body.contract.holdExpiresAt) - 1)), false);
  const cancelled = await cancel(next.body.contract.id, contract.tenantId);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'CANCELLED');
  assert.equal(await prisma.notification.count({ where: { recipientId: owner.id, eventType: 'CONTRACT_HOLD_CANCELLED' } }), 1);
  assert.equal(await prisma.auditLog.count({ where: { entityId: next.body.contract.id, action: 'CONTRACT_HOLD_CANCELLED' } }), 1);
  const released = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
  assert.equal(released.occupancyStatus, 'VACANT');
  assert.equal(released.visibilityStatus, 'VISIBLE');
  assert.equal(await roomIsDiscoverable(), true);

  const lastRequest = await prisma.rentalRequest.create({ data: {
    roomId: room.id, tenantId: contract.tenantId, desiredStartDate: new Date('2028-08-31'), status: 'PENDING',
  } });
  const last = await approve(lastRequest.id);
  assert.equal(last.status, 200);
  const lastDeadline = new Date(last.body.contract.holdExpiresAt);
  const expirationResults = await Promise.all([
    expireHoldForRoom(room.id, lastDeadline),
    expireHoldForContract(last.body.contract.id, lastDeadline),
  ]);
  assert.deepEqual(expirationResults.sort(), [false, true]);
  assert.equal(await prisma.auditLog.count({ where: {
    entityId: last.body.contract.id, action: 'CONTRACT_HOLD_EXPIRED',
  } }), 1);
  assert.equal(await roomIsDiscoverable(), true);
});
