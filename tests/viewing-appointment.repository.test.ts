import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
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
const slotId = '550e8400-e29b-41d4-a716-446655440021';

test('viewing-appointment.repository.ts stays pure persistence without notification, ApiError, or $transaction logic', () => {
  const repoSource = fs.readFileSync(
    path.resolve(__dirname, '../src/modules/viewing-appointments/viewing-appointment.repository.ts'),
    'utf8',
  );
  assert.ok(!repoSource.includes('$transaction'));
  assert.ok(!repoSource.includes('createNotification'));
  assert.ok(!repoSource.includes('NOTIFICATION_EVENT_TYPE'));
  assert.ok(!repoSource.includes('ApiError'));
  assert.ok(!repoSource.includes('formatRoomLabel'));
  assert.ok(!repoSource.includes('NotificationMeta'));
});

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

test('rejectAppointment performs atomic PENDING updateMany using passed tx client and returns count', async () => {
  let updateArgs: any;
  const fakeTx: any = {
    viewingAppointment: {
      updateMany: async (args: any) => {
        updateArgs = args;
        return { count: 0 };
      },
    },
  };

  const result = await ViewingAppointmentRepository.rejectAppointment(
    appointmentId,
    'No longer available',
    fakeTx,
  );

  assert.deepEqual(result, { count: 0 });
  assert.deepEqual(updateArgs.where, { id: appointmentId, status: 'PENDING' });
  assert.deepEqual(updateArgs.data, {
    status: 'REJECTED',
    rejectionReason: 'No longer available',
  });
});

test('cancelAppointment updates only the expected status using passed tx client and returns count', async () => {
  let updateArgs: any;
  const fakeTx: any = {
    viewingAppointment: {
      updateMany: async (args: any) => {
        updateArgs = args;
        return { count: 1 };
      },
    },
  };

  const result = await ViewingAppointmentRepository.cancelAppointment(
    appointmentId,
    'Plans changed',
    'CONFIRMED',
    fakeTx,
  );

  assert.deepEqual(result, { count: 1 });
  assert.deepEqual(updateArgs.where, { id: appointmentId, status: 'CONFIRMED' });
  assert.deepEqual(updateArgs.data, {
    status: 'CANCELLED',
    cancellationReason: 'Plans changed',
  });
});

test('createAppointmentWithSlots, findConflictingConfirmedAppointment, and confirmAppointmentSelection use passed tx client', async () => {
  const calls: string[] = [];
  const fakeTx: any = {
    viewingAppointment: {
      create: async (args: any) => {
        calls.push(`appointment.create:${args.data.roomId}`);
        return { id: appointmentId, status: 'PENDING' };
      },
      findFirst: async (args: any) => {
        calls.push(`appointment.findFirst:${args.where.roomId}:${args.where.status}`);
        return null;
      },
      update: async (args: any) => {
        calls.push(`appointment.update:${args.data.status}:${args.data.selectedSlotId}`);
        return {
          id: appointmentId,
          selectedSlot: { id: slotId, startAt: new Date('2026-12-01T09:00:00Z') },
        };
      },
    },
    viewingTimeOption: {
      create: async (args: any) => {
        calls.push(`slot.create:${args.data.appointmentId}`);
        return { id: slotId };
      },
      update: async (args: any) => {
        calls.push(`slot.update:${args.where.id}:${args.data.isSelected}`);
        return { id: slotId };
      },
    },
  };

  const created = await ViewingAppointmentRepository.createAppointmentWithSlots(
    '550e8400-e29b-41d4-a716-446655440003',
    '0901234567',
    { roomId: '550e8400-e29b-41d4-a716-446655440010', proposedSlots: ['2026-12-01T09:00:00Z'] },
    fakeTx,
  );
  assert.equal(created.id, appointmentId);

  const conflict = await ViewingAppointmentRepository.findConflictingConfirmedAppointment(
    appointmentId,
    '550e8400-e29b-41d4-a716-446655440010',
    new Date('2026-12-01T08:30:00Z'),
    new Date('2026-12-01T09:30:00Z'),
    fakeTx,
  );
  assert.equal(conflict, null);

  const confirmed = await ViewingAppointmentRepository.confirmAppointmentSelection(
    appointmentId,
    slotId,
    fakeTx,
  );
  assert.equal(confirmed.id, appointmentId);

  assert.deepEqual(calls, [
    'appointment.create:550e8400-e29b-41d4-a716-446655440010',
    `slot.create:${appointmentId}`,
    'appointment.findFirst:550e8400-e29b-41d4-a716-446655440010:CONFIRMED',
    `slot.update:${slotId}:true`,
    `appointment.update:CONFIRMED:${slotId}`,
  ]);
});
