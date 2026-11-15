import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../src/common/errors/api-error';
import { validateCreateRentalRequest, validateRejectRentalRequest } from '../src/modules/rental-requests/rental-request.validation';

test('create validation normalizes a valid date, duration, and message', () => {
  const result = validateCreateRentalRequest({ roomId: '550e8400-e29b-41d4-a716-446655440010', desiredMoveInDate: '2026-12-01', durationMonths: '12', message: '  Ready to move  ' });
  assert.equal(result.desiredMoveInDate, '2026-12-01');
  assert.equal(result.durationMonths, 12);
  assert.equal(result.message, 'Ready to move');
});

test('create validation rejects malformed date and non-integer duration', () => {
  assert.throws(() => validateCreateRentalRequest({ roomId: '550e8400-e29b-41d4-a716-446655440010', desiredMoveInDate: 'not-a-date', durationMonths: 2.5 }),
    (error: unknown) => error instanceof ApiError && error.statusCode === 400 && error.code === 'VALIDATION_ERROR');
});

test('reject validation trims the reason and rejects blank input', () => {
  assert.deepEqual(validateRejectRentalRequest({ reason: '  Not suitable  ' }), { reason: 'Not suitable' });
  assert.throws(() => validateRejectRentalRequest({ reason: '   ' }),
    (error: unknown) => error instanceof ApiError && error.statusCode === 400 && error.code === 'VALIDATION_ERROR');
});