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
  stub(prisma.viewingAppointment, 'updateMany', async (args: any) => { updateArgs = args; return { count: 0 }; });
  stub(prisma.viewingAppointment, 'update', async () => ({ id: appointmentId }));

  await assert.rejects(
    () => ViewingAppointmentRepository.rejectAppointment(appointmentId, 'No longer available'),
    (error: unknown) => error instanceof ApiError && error.statusCode === 409,
  );
  assert.deepEqual(updateArgs.where, { id: appointmentId, status: 'PENDING' });
});

test('cancelAppointment updates only the state observed by the service', async () => {
  let updateArgs: any;
  stub(prisma.viewingAppointment, 'updateMany', async (args: any) => { updateArgs = args; return { count: 0 }; });
  stub(prisma.viewingAppointment, 'update', async () => ({ id: appointmentId }));

  await assert.rejects(
    () => ViewingAppointmentRepository.cancelAppointment(appointmentId, 'Plans changed', 'CONFIRMED' as any),
    (error: unknown) => error instanceof ApiError && error.statusCode === 409,
  );
  assert.deepEqual(updateArgs.where, { id: appointmentId, status: 'CONFIRMED' });
});

test('confirmAppointmentInTx maps a serializable conflict to a slot conflict', async () => {
  let transactionOptions: any;
  stub(prisma, '$transaction', async (_work: unknown, options: any) => {
    transactionOptions = options;
    throw { code: 'P2034' };
  });
  stub(prisma.viewingAppointment, 'findUnique', async () => ({ status: 'PENDING' }));

  await assert.rejects(
    () => ViewingAppointmentRepository.confirmAppointmentInTx(appointmentId, '550e8400-e29b-41d4-a716-446655440021'),
    (error: unknown) => error instanceof ApiError && error.statusCode === 409 && error.code === 'SLOT_CONFLICT',
  );
  assert.equal(transactionOptions.isolationLevel, 'Serializable');
});
