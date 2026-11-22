import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ApiError } from '../src/common/errors/api-error';
import { prisma } from '../src/infrastructure/database/prisma';
import { ViewingAppointmentRepository } from '../src/modules/viewing-appointments/viewing-appointment.repository';

const undo: Array<() => void> = [];
afterEach(() => { while (undo.length) undo.pop()!(); });
function stub(delegate: any, name: string, implementation: (...args: any[]) => any) {
  const original = delegate[name];
  delegate[name] = implementation;
  undo.push(() => { delegate[name] = original; });
}
const appointmentId = '550e8400-e29b-41d4-a716-446655440020';

test('findAppointmentsList has a deterministic ID tie-breaker for equal creation times', async () => {
  let findArgs: any;
  stub(prisma.viewingAppointment, 'findMany', async (args: any) => { findArgs = args; return []; });
  stub(prisma.viewingAppointment, 'count', async () => 0);

  await ViewingAppointmentRepository.findAppointmentsList(
    { id: '550e8400-e29b-41d4-a716-446655440001', role: 'TENANT' },
    { page: 1, pageSize: 10 },
  );

  assert.deepEqual(findArgs.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
});

test('rejectAppointment reports conflict when the pending state was already consumed', async () => {
  let updateArgs: any;
  let notificationCreated = false;
  stub(prisma, '$transaction', async (work: any) => work(prisma));
  stub(prisma.viewingAppointment, 'updateMany', async (args: any) => { updateArgs = args; return { count: 0 }; });
  stub(prisma.notification, 'create', async () => { notificationCreated = true; return {}; });
  stub(prisma.viewingAppointment, 'update', async () => ({ id: appointmentId }));

  await assert.rejects(
    () => ViewingAppointmentRepository.rejectAppointment(appointmentId, 'No longer available', { tenantId: '550e8400-e29b-41d4-a716-446655440003' }),
    (error: unknown) => error instanceof ApiError && error.statusCode === 409,
  );
  assert.deepEqual(updateArgs.where, { id: appointmentId, status: 'PENDING' });
  assert.equal(notificationCreated, false);
});

test('cancelAppointment updates only the state observed by the service', async () => {
  let updateArgs: any;
  let notificationCreated = false;
  stub(prisma, '$transaction', async (work: any) => work(prisma));
  stub(prisma.viewingAppointment, 'updateMany', async (args: any) => { updateArgs = args; return { count: 0 }; });
  stub(prisma.notification, 'create', async () => { notificationCreated = true; return {}; });
  stub(prisma.viewingAppointment, 'update', async () => ({ id: appointmentId }));

  await assert.rejects(
    () => ViewingAppointmentRepository.cancelAppointment(appointmentId, 'Plans changed', 'CONFIRMED' as any, { recipientId: '550e8400-e29b-41d4-a716-446655440001', canceledByRole: 'TENANT' }),
    (error: unknown) => error instanceof ApiError && error.statusCode === 409,
  );
  assert.deepEqual(updateArgs.where, { id: appointmentId, status: 'CONFIRMED' });
  assert.equal(notificationCreated, false);
});

test('ViewingAppointmentRepository creates atomic notifications on create, confirm, reject, and cancel', async () => {
  const createdNotifications: any[] = [];
  stub(prisma, '$transaction', async (work: any) => work(prisma));
  stub(prisma.notification, 'create', async (args: any) => {
    createdNotifications.push(args.data);
    return { id: 'notif-1', ...args.data };
  });

  // 1. Create appointment -> notify landlord
  stub(prisma.viewingAppointment, 'create', async () => ({ id: appointmentId, status: 'PENDING' }));
  stub(prisma.viewingTimeOption, 'create', async () => ({ id: 'slot-1' }));
  await ViewingAppointmentRepository.createAppointmentWithSlots(
    '550e8400-e29b-41d4-a716-446655440003',
    '0901234567',
    { roomId: '550e8400-e29b-41d4-a716-446655440010', proposedSlots: ['2026-12-01T09:00:00Z'] },
    { landlordId: '550e8400-e29b-41d4-a716-446655440001', roomCode: 'P.101', propertyName: 'Khu trọ A' },
  );

  // 2. Confirm appointment -> notify tenant
  const slotId = '550e8400-e29b-41d4-a716-446655440021';
  stub(prisma.viewingAppointment, 'findUnique', async () => ({
    id: appointmentId,
    roomId: '550e8400-e29b-41d4-a716-446655440010',
    tenantId: '550e8400-e29b-41d4-a716-446655440003',
    status: 'PENDING',
    timeOptions: [{ id: slotId, startAt: new Date('2026-12-01T09:00:00Z') }],
    room: { roomCode: 'P.101', property: { name: 'Khu trọ A' } },
  }));
  stub(prisma.viewingAppointment, 'findFirst', async () => null);
  stub(prisma.viewingTimeOption, 'update', async () => ({ id: slotId }));
  stub(prisma.viewingAppointment, 'update', async () => ({
    id: appointmentId,
    selectedSlot: { id: slotId, startAt: new Date('2026-12-01T09:00:00Z') },
  }));
  await ViewingAppointmentRepository.confirmAppointmentInTx(appointmentId, slotId);

  // 3. Reject & 4. Cancel
  stub(prisma.viewingAppointment, 'updateMany', async () => ({ count: 1 }));
  await ViewingAppointmentRepository.rejectAppointment(appointmentId, 'Bận đột xuất', {
    tenantId: '550e8400-e29b-41d4-a716-446655440003',
    roomCode: 'P.101',
  });
  await ViewingAppointmentRepository.cancelAppointment(appointmentId, 'Đổi kế hoạch', 'PENDING', {
    recipientId: '550e8400-e29b-41d4-a716-446655440001',
    roomCode: 'P.101',
    canceledByRole: 'TENANT',
  });

  assert.equal(createdNotifications.length, 4);
  assert.equal(createdNotifications[0].eventType, 'VIEWING_APPOINTMENT_CREATED');
  assert.equal(createdNotifications[0].recipientId, '550e8400-e29b-41d4-a716-446655440001');
  assert.equal(createdNotifications[1].eventType, 'VIEWING_APPOINTMENT_CONFIRMED');
  assert.equal(createdNotifications[1].recipientId, '550e8400-e29b-41d4-a716-446655440003');
  assert.equal(createdNotifications[2].eventType, 'VIEWING_APPOINTMENT_REJECTED');
  assert.equal(createdNotifications[2].recipientId, '550e8400-e29b-41d4-a716-446655440003');
  assert.equal(createdNotifications[3].eventType, 'VIEWING_APPOINTMENT_CANCELLED');
  assert.equal(createdNotifications[3].recipientId, '550e8400-e29b-41d4-a716-446655440001');
});

test('confirmAppointmentInTx maps a serializable conflict to a slot conflict', async () => {
  let transactionOptions: any;
  let notificationCreated = false;
  stub(prisma, '$transaction', async (_work: unknown, options: any) => {
    transactionOptions = options;
    throw { code: 'P2034' };
  });
  stub(prisma.notification, 'create', async () => {
    notificationCreated = true;
    return {};
  });
  stub(prisma.viewingAppointment, 'findUnique', async () => ({ status: 'PENDING' }));

  await assert.rejects(
    () => ViewingAppointmentRepository.confirmAppointmentInTx(appointmentId, '550e8400-e29b-41d4-a716-446655440021'),
    (error: unknown) => error instanceof ApiError && error.statusCode === 409 && error.code === 'SLOT_CONFLICT',
  );
  assert.equal(transactionOptions.isolationLevel, 'Serializable');
  assert.equal(notificationCreated, false);
});
