import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ApiError } from '../src/common/errors/api-error';
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
const appointmentId = '550e8400-e29b-41d4-a716-446655440020';
const slotId = '550e8400-e29b-41d4-a716-446655440021';
const appointment = {
  id: appointmentId, roomId: '550e8400-e29b-41d4-a716-446655440010', tenantId,
  status: 'PENDING', timeOptions: [{ id: slotId, startAt: new Date(Date.now() + 60_000) }],
  selectedSlot: null, room: { property: { landlordId } },
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
  stub(ViewingAppointmentRepository, 'rejectAppointment', async () => { wrote = true; return { id: appointmentId }; });
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

test('cancelAppointment passes the opposite party as notification recipient', async () => {
  let capturedNotificationMeta: any;
  stub(ViewingAppointmentRepository, 'findAppointmentById', async () => appointment);
  stub(ViewingAppointmentRepository, 'cancelAppointment', async (_id: string, _reason: string, _expected: any, meta: any) => {
    capturedNotificationMeta = meta;
    return { id: appointmentId };
  });

  await ViewingAppointmentService.cancelAppointment(
    { id: tenantId, role: 'TENANT' },
    appointmentId,
    { reason: 'Đổi lịch' },
  );
  assert.equal(capturedNotificationMeta.recipientId, landlordId);

  await ViewingAppointmentService.cancelAppointment(
    { id: landlordId, role: 'LANDLORD' },
    appointmentId,
    { reason: 'Bận việc' },
  );
  assert.equal(capturedNotificationMeta.recipientId, tenantId);
});