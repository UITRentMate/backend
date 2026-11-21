import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { app } from '../src/app';
import { prisma } from '../src/infrastructure/database/prisma';
import { signAccessToken } from '../src/modules/auth/auth.security';

process.env.JWT_SECRET = 'test-secret-must-have-at-least-thirty-two-bytes';

test('Live DB: simultaneous duplicate rental requests yield one PENDING request', async (t) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    t.skip('PostgreSQL is not available');
    return;
  }

  const requiredColumns = ['duration_months', 'message', 'rejection_reason'];
  const columnRows = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'rental_requests'
      AND column_name IN ('duration_months', 'message', 'rejection_reason')
  `;
  const existingColumns = new Set(columnRows.map(({ column_name }) => column_name));
  const missingColumns = requiredColumns.filter((column) => !existingColumns.has(column));
  if (missingColumns.length > 0) {
    t.skip('Rental request migration is not applied; missing columns: ' + missingColumns.join(', '));
    return;
  }

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const userIds: string[] = [];
  let propertyId: string | undefined;
  let roomId: string | undefined;
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const landlord = await prisma.user.create({ data: {
      fullName: 'Rental Race Landlord', email: `rental-race-owner-${suffix}@rentmate.test`,
      phone: `09${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`,
      passwordHash: 'test-only', role: 'LANDLORD', accountStatus: 'ACTIVE',
    } });
    userIds.push(landlord.id);
    const tenant = await prisma.user.create({ data: {
      fullName: 'Rental Race Tenant', email: `rental-race-tenant-${suffix}@rentmate.test`,
      phone: `09${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`,
      passwordHash: 'test-only', role: 'TENANT', accountStatus: 'ACTIVE',
    } });
    userIds.push(tenant.id);

    const property = await prisma.property.create({ data: {
      landlordId: landlord.id, name: `Rental Race Property ${suffix}`, address: 'Test address', status: 'ACTIVE',
    } });
    propertyId = property.id;
    const room = await prisma.room.create({ data: {
      propertyId, roomCode: `RR-${suffix}`, areaM2: 20, maxOccupants: 2, monthlyRent: 1000000,
      depositRequired: 1000000, electricityRate: 1000, waterRate: 1000,
      occupancyStatus: 'VACANT', visibilityStatus: 'VISIBLE',
    } });
    roomId = room.id;

    const port = (server.address() as AddressInfo).port;
    const token = signAccessToken(tenant.id);
    const responses = await Promise.all([1, 2].map(() => fetch(`http://127.0.0.1:${port}/api/v1/rental-requests`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, desiredMoveInDate: '2027-12-01', durationMonths: 12 }),
    })));
    const results = await Promise.all(responses.map(async (response) => ({
      status: response.status,
      body: await response.json() as Record<string, unknown>,
    })));

    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
    assert.equal(results.find((result) => result.status === 409)?.body.code, 'DUPLICATE_RENTAL_REQUEST');
    const pendingCount = await prisma.rentalRequest.count({ where: { roomId, tenantId: tenant.id, status: 'PENDING' } });
    assert.equal(pendingCount, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (roomId && userIds[1]) {
      await prisma.rentalRequest.deleteMany({ where: { roomId, tenantId: userIds[1] } }).catch(() => {});
    }
    if (roomId) await prisma.room.delete({ where: { id: roomId } }).catch(() => {});
    if (propertyId) await prisma.property.delete({ where: { id: propertyId } }).catch(() => {});
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }
});
