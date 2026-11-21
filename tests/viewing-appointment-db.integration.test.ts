import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { app } from '../src/app';
import { prisma } from '../src/infrastructure/database/prisma';
import { signAccessToken } from '../src/modules/auth/auth.security';

process.env.JWT_SECRET = 'test-secret-must-have-at-least-thirty-two-bytes';
async function request(path: string, token: string, body: unknown) {
  const server = app.listen(0);
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { response, body: await response.json() as any };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('Live DB: concurrent confirmations of one room/time slot cannot both succeed', async (t) => {
  try { await prisma.$queryRaw`SELECT 1`; } catch { t.skip('PostgreSQL is not available'); return; }

  const requiredColumns = ['note', 'rejection_reason', 'cancellation_reason'];
  const columnRows = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'viewing_appointments'
      AND column_name IN ('note', 'rejection_reason', 'cancellation_reason')
  `;
  const existingColumns = new Set(columnRows.map(({ column_name }) => column_name));
  const missingColumns = requiredColumns.filter((column) => !existingColumns.has(column));
  if (missingColumns.length > 0) {
    t.skip('Viewing appointment migration is not applied; missing columns: ' + missingColumns.join(', '));
    return;
  }

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const users: string[] = [];
  let propertyId: string | undefined;
  let roomId: string | undefined;
  const appointmentIds: string[] = [];
  try {
    const landlord = await prisma.user.create({ data: {
      fullName: 'Viewing Race Landlord', email: `viewing-race-owner-${suffix}@rentmate.test`,
      phone: `09${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`,
      passwordHash: 'test-only', role: 'LANDLORD', accountStatus: 'ACTIVE',
    } });
    users.push(landlord.id);
    const tenants = await Promise.all([1, 2].map((n) => prisma.user.create({ data: {
      fullName: `Viewing Race Tenant ${n}`, email: `viewing-race-${n}-${suffix}@rentmate.test`,
      phone: `09${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`,
      passwordHash: 'test-only', role: 'TENANT', accountStatus: 'ACTIVE',
    } })));
    users.push(...tenants.map((user) => user.id));
    const property = await prisma.property.create({ data: {
      landlordId: landlord.id, name: 'Viewing Race Property', address: 'Test address', status: 'ACTIVE',
    } });
    propertyId = property.id;
    const room = await prisma.room.create({ data: {
      propertyId, roomCode: `VR-${suffix}`, areaM2: 20, maxOccupants: 2, monthlyRent: 1000000,
      depositRequired: 1000000, electricityRate: 1000, waterRate: 1000,
      occupancyStatus: 'VACANT', visibilityStatus: 'VISIBLE',
    } });
    roomId = room.id;
    const startAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const appointments = await Promise.all(tenants.map((tenant) => prisma.viewingAppointment.create({
      data: {
        roomId: room.id, tenantId: tenant.id, contactPhone: tenant.phone, status: 'PENDING',
        timeOptions: { create: { proposedBy: tenant.id, startAt, isSelected: false } },
      }, include: { timeOptions: true },
    })));
    appointmentIds.push(...appointments.map((appointment) => appointment.id));

    const token = signAccessToken(landlord.id);
    const results = await Promise.all(appointments.map((appointment) => request(
      `/api/v1/viewing-appointments/${appointment.id}/confirm`, token,
      { selectedSlotId: appointment.timeOptions[0].id },
    )));
    assert.deepEqual(results.map(({ response }) => response.status).sort(), [200, 409]);
    assert.equal(results.find(({ response }) => response.status === 409)?.body.code, 'SLOT_CONFLICT');
    const finalRows = await prisma.viewingAppointment.findMany({ where: { id: { in: appointmentIds } }, select: { status: true } });
    assert.equal(finalRows.filter((row) => row.status === 'CONFIRMED').length, 1);
  } finally {
    if (appointmentIds.length) await prisma.viewingAppointment.deleteMany({ where: { id: { in: appointmentIds } } }).catch(() => {});
    if (roomId) await prisma.room.delete({ where: { id: roomId } }).catch(() => {});
    if (propertyId) await prisma.property.delete({ where: { id: propertyId } }).catch(() => {});
    if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  }
});