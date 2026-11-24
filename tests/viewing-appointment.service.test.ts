import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { NOTIFICATION_EVENT_TYPE } from '../src/common/constants/phase3-status';
import { ApiError } from '../src/common/errors/api-error';
import { prisma } from '../src/infrastructure/database/prisma';
import { ViewingAppointmentRepository } from '../src/modules/viewing-appointments/viewing-appointment.repository';
import { ViewingAppointmentService } from '../src/modules/viewing-appointments/viewing-appointment.service';

const undo: Array<() => void> = [];
afterEach(() => { while (undo.length) undo.pop()!(); });
function stub(delegate: any, name: string, implementation: (...args: any[]) => any) {
  const original = delegate[name]; delegate[name] = implementation; undo.push(() => { delegate[name] = original; });
}
const landlordId = '550e8400-e29b-41d4-a716-446655440001';
const otherLandlordId = '550e8400-e29b-41d4-a716-446655440002';
const tenantId = '550e8400-e29b-41d4-a716-446655440003';
const roomId = '550e8400-e29b-41d4-a716-446655440010';
const propertyId = '550e8400-e29b-41d4-a716-446655440011';
const appointmentId = '550e8400-e29b-41d4-a716-446655440020';
const slotId = '550e8400-e29b-41d4-a716-446655440021';
const slotStartAt = new Date(Date.now() + 60_000);
const appointment = {
  id: appointmentId,
  roomId,
  tenantId,
  status: 'PENDING',
  timeOptions: [{ id: slotId, startAt: slotStartAt, isSelected: false }],
  selectedSlot: null,
  room: {
    id: roomId,
    roomCode: 'P.202',
    property: { id: propertyId, name: 'Khu trọ Hạnh Phúc', address: '123 ABC', landlordId },
  },
};

test('confirmAppointment hides an appointment from a different landlord', async () => {
  stub(ViewingAppointmentRepository, 'findAppointmentById', async () => appointment);
  await assert.rejects(
    () => ViewingAppointmentService.confirmAppointment(otherLandlordId, appointmentId, { selectedSlotId: slotId }),
    (error: unknown) => error instanceof ApiError && error.statusCode === 404 && error.code === 'APPOINTMENT_NOT_FOUND',
  );
});

test('rejectAppointment rejects a non-pending state before calling the repository', async () => {
  stub(ViewingAppointmentRepository, 'findAppointmentById', async () => ({ ...appointment, status: 'CONFIRMED' }));
  let wrote = false;
  stub(ViewingAppointmentRepository, 'rejectAppointment', async () => { wrote = true; return { count: 1 }; });
  await assert.rejects(
    () => ViewingAppointmentService.rejectAppointment(landlordId, appointmentId, { reason: 'Unavailable' }),
    (error: unknown) => error instanceof ApiError && error.statusCode === 409 && error.code === 'CONFLICT',
  );
  assert.equal(wrote, false);
});

test('cancelAppointment rejects a confirmed slot that has already started', async () => {
  stub(ViewingAppointmentRepository, 'findAppointmentById', async () => ({
    ...appointment, status: 'CONFIRMED', selectedSlot: { id: slotId, startAt: new Date(Date.now() - 1_000) },
  }));
  await assert.rejects(
    () => ViewingAppointmentService.cancelAppointment({ id: tenantId, role: 'TENANT' }, appointmentId, { reason: 'Plans changed' }),
    (error: unknown) => error instanceof ApiError && error.statusCode === 409 && error.code === 'CANCELLATION_CUTOFF_EXCEEDED',
  );
});

test('cancelAppointment creates notification for the opposite party with role-specific actionUrl in the same tx', async () => {
  const createdNotifications: any[] = [];
  const passedClients: any[] = [];
  const txClient: any = {
    notification: {
      create: async (args: any) => {
        createdNotifications.push(args.data);
        return { id: 'notif-1', ...args.data };
      },
    },
  };

  stub(prisma, '$transaction', async (work: any) => work(txClient));
  stub(ViewingAppointmentRepository, 'findAppointmentById', async () => appointment);
  stub(ViewingAppointmentRepository, 'cancelAppointment', async (_id: string, _reason: string, _expected: any, client: any) => {
    passedClients.push(client);
    return { count: 1 };
  });

  await ViewingAppointmentService.cancelAppointment(
    { id: tenantId, role: 'TENANT' },
    appointmentId,
    { reason: 'Đổi lịch' },
  );
  assert.equal(passedClients[0], txClient);
  assert.equal(createdNotifications[0].recipientId, landlordId);
  assert.equal(createdNotifications[0].eventType, NOTIFICATION_EVENT_TYPE.VIEWING_APPOINTMENT_CANCELLED);
  assert.equal(createdNotifications[0].payload.actionUrl, `/landlord/viewing-appointments/${appointmentId}`);
  assert.ok(createdNotifications[0].payload.content.includes('Người thuê'));
  assert.ok(createdNotifications[0].payload.content.includes('phòng P.202 (Khu trọ Hạnh Phúc)'));

  await ViewingAppointmentService.cancelAppointment(
    { id: landlordId, role: 'LANDLORD' },
    appointmentId,
    { reason: 'Bận việc' },
  );
  assert.equal(passedClients[1], txClient);
  assert.equal(createdNotifications[1].recipientId, tenantId);
  assert.equal(createdNotifications[1].eventType, NOTIFICATION_EVENT_TYPE.VIEWING_APPOINTMENT_CANCELLED);
  assert.equal(createdNotifications[1].payload.actionUrl, `/viewing-appointments/${appointmentId}`);
  assert.ok(createdNotifications[1].payload.content.includes('Chủ trọ'));
  assert.ok(createdNotifications[1].payload.content.includes('phòng P.202 (Khu trọ Hạnh Phúc)'));
});

test('ViewingAppointmentService coordinates transactions and creates atomic notifications on create, confirm, and reject', async () => {
  const createdNotifications: any[] = [];
  const txClientsUsed: any[] = [];
  let transactionOptions: any;
  const txClient: any = {
    notification: {
      create: async (args: any) => {
        createdNotifications.push(args.data);
        return { id: `notif-${createdNotifications.length}`, ...args.data };
      },
    },
  };

  stub(prisma, '$transaction', async (work: any, options?: any) => {
    transactionOptions = options;
    return work(txClient);
  });

  // 1. Create appointment -> notify landlord
  stub(prisma.user, 'findUnique', async () => ({ id: tenantId, phone: '0901234567' }));
  stub(ViewingAppointmentRepository, 'validateRoomPublicEligibility', async () => ({
    id: roomId,
    roomCode: 'P.202',
    property: { id: propertyId, name: 'Khu trọ Hạnh Phúc', landlordId },
  }));
  stub(ViewingAppointmentRepository, 'hasPendingAppointmentForRoom', async () => false);
  stub(
    ViewingAppointmentRepository,
    'createAppointmentWithSlots',
    async (_tenantId: string, _phone: string, _input: any, client: any) => {
      txClientsUsed.push(client);
      return { id: appointmentId, status: 'PENDING' };
    },
  );

  await ViewingAppointmentService.createAppointment(tenantId, {
    roomId,
    proposedSlots: ['2026-12-01T09:00:00Z'],
    contactPhone: '0901234567',
  });

  // 2. Confirm appointment -> notify tenant inside Serializable tx
  stub(ViewingAppointmentRepository, 'findAppointmentById', async (_id: string, client?: any) => {
    if (client) txClientsUsed.push(client);
    return appointment;
  });
  stub(
    ViewingAppointmentRepository,
    'findConflictingConfirmedAppointment',
    async (_id: string, _roomId: string, _start: Date, _end: Date, client: any) => {
      txClientsUsed.push(client);
      return null;
    },
  );
  stub(
    ViewingAppointmentRepository,
    'confirmAppointmentSelection',
    async (_id: string, _slotId: string, client: any) => {
      txClientsUsed.push(client);
      return { id: appointmentId, selectedSlot: { id: slotId, startAt: slotStartAt } };
    },
  );

  await ViewingAppointmentService.confirmAppointment(landlordId, appointmentId, {
    selectedSlotId: slotId,
  });
  assert.equal(transactionOptions?.isolationLevel, 'Serializable');

  // 3. Reject appointment -> notify tenant
  stub(
    ViewingAppointmentRepository,
    'rejectAppointment',
    async (_id: string, _reason: string, client: any) => {
      txClientsUsed.push(client);
      return { count: 1 };
    },
  );

  await ViewingAppointmentService.rejectAppointment(landlordId, appointmentId, {
    reason: 'Không tiếp khách',
  });

  assert.ok(txClientsUsed.every((client) => client === txClient));
  assert.equal(createdNotifications.length, 3);

  assert.equal(createdNotifications[0].recipientId, landlordId);
  assert.equal(createdNotifications[0].eventType, NOTIFICATION_EVENT_TYPE.VIEWING_APPOINTMENT_CREATED);
  assert.equal(createdNotifications[0].payload.actionUrl, `/landlord/viewing-appointments/${appointmentId}`);
  assert.ok(createdNotifications[0].payload.content.includes('phòng P.202 (Khu trọ Hạnh Phúc)'));

  assert.equal(createdNotifications[1].recipientId, tenantId);
  assert.equal(createdNotifications[1].eventType, NOTIFICATION_EVENT_TYPE.VIEWING_APPOINTMENT_CONFIRMED);
  assert.equal(createdNotifications[1].payload.actionUrl, `/viewing-appointments/${appointmentId}`);
  assert.deepEqual(createdNotifications[1].payload.metadata, {
    selectedSlotId: slotId,
    startAt: slotStartAt.toISOString(),
  });

  assert.equal(createdNotifications[2].recipientId, tenantId);
  assert.equal(createdNotifications[2].eventType, NOTIFICATION_EVENT_TYPE.VIEWING_APPOINTMENT_REJECTED);
  assert.equal(createdNotifications[2].payload.actionUrl, `/viewing-appointments/${appointmentId}`);
  assert.ok(createdNotifications[2].payload.content.includes('Lý do: Không tiếp khách'));
});

test('rejectAppointment and cancelAppointment do not emit notifications when updateMany count is 0', async () => {
  let notificationCreated = false;
  const txClient: any = {
    notification: {
      create: async () => {
        notificationCreated = true;
        return {};
      },
    },
  };

  stub(prisma, '$transaction', async (work: any) => work(txClient));
  stub(ViewingAppointmentRepository, 'findAppointmentById', async () => appointment);
  stub(ViewingAppointmentRepository, 'rejectAppointment', async () => ({ count: 0 }));
  stub(ViewingAppointmentRepository, 'cancelAppointment', async () => ({ count: 0 }));

  await assert.rejects(
    () => ViewingAppointmentService.rejectAppointment(landlordId, appointmentId, { reason: 'Trùng lịch' }),
    (error: unknown) => error instanceof ApiError && error.statusCode === 409 && error.code === 'CONFLICT',
  );
  await assert.rejects(
    () => ViewingAppointmentService.cancelAppointment({ id: tenantId, role: 'TENANT' }, appointmentId, { reason: 'Đổi ý' }),
    (error: unknown) => error instanceof ApiError && error.statusCode === 409 && error.code === 'CONFLICT',
  );

  assert.equal(notificationCreated, false);
});

test('confirmAppointment maps slot conflict and P2034 serializable conflict without emitting notifications', async () => {
  let transactionOptions: any;
  let notificationCreated = false;
  const txClient: any = {
    notification: {
      create: async () => {
        notificationCreated = true;
        return {};
      },
    },
  };

  // Case 1: In-tx slot conflict check fails -> 409 SLOT_CONFLICT, no notification
  stub(prisma, '$transaction', async (work: any, options?: any) => {
    transactionOptions = options;
    return work(txClient);
  });
  stub(ViewingAppointmentRepository, 'findAppointmentById', async () => appointment);
  stub(ViewingAppointmentRepository, 'findConflictingConfirmedAppointment', async () => ({ id: 'other-appt' }));

  await assert.rejects(
    () => ViewingAppointmentService.confirmAppointment(landlordId, appointmentId, { selectedSlotId: slotId }),
    (error: unknown) => error instanceof ApiError && error.statusCode === 409 && error.code === 'SLOT_CONFLICT',
  );
  assert.equal(transactionOptions.isolationLevel, 'Serializable');
  assert.equal(notificationCreated, false);

  // Case 2: P2034 serialization conflict while still PENDING -> 409 SLOT_CONFLICT, no notification
  stub(prisma, '$transaction', async (_work: any, options?: any) => {
    transactionOptions = options;
    throw { code: 'P2034' };
  });
  stub(ViewingAppointmentRepository, 'findAppointmentStatusById', async () => ({ status: 'PENDING' }));

  await assert.rejects(
    () => ViewingAppointmentService.confirmAppointment(landlordId, appointmentId, { selectedSlotId: slotId }),
    (error: unknown) => error instanceof ApiError && error.statusCode === 409 && error.code === 'SLOT_CONFLICT',
  );
  assert.equal(transactionOptions.isolationLevel, 'Serializable');
  assert.equal(notificationCreated, false);

  // Case 3: P2034 serialization conflict when already consumed -> 409 CONFLICT, no notification
  stub(ViewingAppointmentRepository, 'findAppointmentStatusById', async () => ({ status: 'CONFIRMED' }));

  await assert.rejects(
    () => ViewingAppointmentService.confirmAppointment(landlordId, appointmentId, { selectedSlotId: slotId }),
    (error: unknown) => error instanceof ApiError && error.statusCode === 409 && error.code === 'CONFLICT',
  );
  assert.equal(notificationCreated, false);
});