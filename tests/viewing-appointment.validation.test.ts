import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../src/common/errors/api-error';
import { validateCreateViewingAppointment } from '../src/modules/viewing-appointments/viewing-appointment.validation';

const roomId = '550e8400-e29b-41d4-a716-446655440010';
const validSlot = new Date(Date.now() + 48 * 60 * 60 * 1000);

function payload(offsets: number[]) {
  return {
    roomId,
    proposedSlots: offsets.map((minutes) => new Date(validSlot.getTime() + minutes * 60_000).toISOString()),
    contactPhone: '0901234567',
  };
}

test('create validation accepts the one-to-three slot contract', () => {
  assert.equal(validateCreateViewingAppointment(payload([0])).proposedSlots.length, 1);
  assert.equal(validateCreateViewingAppointment(payload([0, 30, 60])).proposedSlots.length, 3);
});

test('create validation rejects proposed slots that overlap the viewing duration', () => {
  assert.throws(
    () => validateCreateViewingAppointment(payload([0, 15])),
    (error: unknown) => error instanceof ApiError && error.statusCode === 400 && error.code === 'VALIDATION_ERROR',
  );
});