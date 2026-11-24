import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { afterEach, test } from 'node:test';
import type { Request, Response } from 'express';
import { app } from '../src/app';
import { ApiError } from '../src/common/errors/api-error';
import { prisma } from '../src/infrastructure/database/prisma';
import { signAccessToken } from '../src/modules/auth/auth.security';
import { ViewingAppointmentController } from '../src/modules/viewing-appointments/viewing-appointment.controller';
import { ViewingAppointmentService } from '../src/modules/viewing-appointments/viewing-appointment.service';

process.env.JWT_SECRET = 'test-secret-must-have-at-least-thirty-two-bytes';
const undo: Array<() => void> = [];
afterEach(() => { while (undo.length) undo.pop()!(); });
function stub(delegate: any, name: string, implementation: (...args: any[]) => any) {
  const original = delegate[name]; delegate[name] = implementation; undo.push(() => { delegate[name] = original; });
}
const landlord = { id: '550e8400-e29b-41d4-a716-446655440001', role: 'LANDLORD', accountStatus: 'ACTIVE', fullName: 'Landlord A' };
const tenant = { id: '550e8400-e29b-41d4-a716-446655440002', role: 'TENANT', accountStatus: 'ACTIVE', fullName: 'Tenant A' };
const otherTenant = { id: '550e8400-e29b-41d4-a716-446655440003', role: 'TENANT', accountStatus: 'ACTIVE', fullName: 'Tenant B' };
const appointmentId = '550e8400-e29b-41d4-a716-446655440020';
const sampleAppointment = {
  id: appointmentId, roomId: '550e8400-e29b-41d4-a716-446655440010', tenantId: tenant.id,
  status: 'PENDING', contactPhone: '0901234567', note: null, rejectionReason: null, cancellationReason: null,
  createdAt: new Date(), timeOptions: [], selectedSlot: null,
  room: { id: '550e8400-e29b-41d4-a716-446655440010', roomCode: 'A1', property: { id: '550e8400-e29b-41d4-a716-446655440011', name: 'Property A', address: 'Address A', landlordId: landlord.id } },
  tenant: { id: tenant.id, fullName: tenant.fullName },
};
async function request(path: string, init: RequestInit = {}) {
  const server = app.listen(0);
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : {} };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
function auth(user: typeof landlord | typeof tenant | typeof otherTenant) {
  return { Authorization: `Bearer ${signAccessToken(user.id)}` };
}

test('viewing list requires a bearer token', async () => {
  const { response, body } = await request('/api/v1/viewing-appointments');
  assert.equal(response.status, 401);
  assert.equal(body.code, 'UNAUTHORIZED');
});

test('viewing list serves an active landlord through the HTTP route', async () => {
  stub(prisma.user, 'findUnique', async () => landlord);
  stub(prisma.viewingAppointment, 'findMany', async () => []);
  stub(prisma.viewingAppointment, 'count', async () => 0);
  const { response, body } = await request('/api/v1/viewing-appointments?page=1&pageSize=10', { headers: auth(landlord) });
  assert.equal(response.status, 200);
  assert.deepEqual(body.items, []);
  assert.equal(body.total, 0);
});

test('viewing detail hides another tenant appointment with 404', async () => {
  stub(prisma.user, 'findUnique', async () => otherTenant);
  stub(prisma.viewingAppointment, 'findUnique', async () => sampleAppointment);
  const { response, body } = await request(`/api/v1/viewing-appointments/${appointmentId}`, { headers: auth(otherTenant) });
  assert.equal(response.status, 404);
  assert.equal(body.code, 'APPOINTMENT_NOT_FOUND');
});

test('tenant cannot confirm through the HTTP route', async () => {
  stub(prisma.user, 'findUnique', async () => tenant);
  const { response, body } = await request(`/api/v1/viewing-appointments/${appointmentId}/confirm`, {
    method: 'PATCH', headers: { ...auth(tenant), 'Content-Type': 'application/json' },
    body: JSON.stringify({ selectedSlotId: '550e8400-e29b-41d4-a716-446655440021' }),
  });
  assert.equal(response.status, 403);
  assert.equal(body.code, 'FORBIDDEN');
});

test('viewing cancel returns 409 when a concurrent transition consumed PENDING', async () => {
  stub(prisma.user, 'findUnique', async () => tenant);
  stub(prisma.viewingAppointment, 'findUnique', async () => sampleAppointment);
  stub(prisma, '$transaction', async (work: any) => work(prisma));
  stub(prisma.viewingAppointment, 'updateMany', async () => ({ count: 0 }));
  const { response, body } = await request(`/api/v1/viewing-appointments/${appointmentId}/cancel`, {
    method: 'PATCH', headers: { ...auth(tenant), 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'Plans changed' }),
  });
  assert.equal(response.status, 409);
  assert.equal(body.code, 'CONFLICT');
});

test('controller returns 401 instead of inventing TENANT when currentUser is absent', async () => {
  const original = ViewingAppointmentService.getAppointmentList;
  ViewingAppointmentService.getAppointmentList = async () => ({ items: [], total: 0, page: 1, pageSize: 10, totalPages: 0 });
  const errors: unknown[] = [];
  const response: any = { locals: { userId: tenant.id }, status() { return this; }, json() { return this; } };
  try {
    await ViewingAppointmentController.getViewingAppointments({ query: {} } as Request, response as Response, (error) => errors.push(error));
  } finally {
    ViewingAppointmentService.getAppointmentList = original;
  }
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof ApiError);
  assert.equal((errors[0] as ApiError).statusCode, 401);
  assert.equal((errors[0] as ApiError).code, 'UNAUTHORIZED');
});