import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapToRentalRequestCreated } from '../src/modules/rental-requests/rental-request.mapper';

test('rental request mapper preserves the Prisma UTC date-only value', () => {
  const result = mapToRentalRequestCreated({
    id: 'request-1', roomId: 'room-1', tenantId: 'tenant-1',
    desiredStartDate: new Date('2026-11-20T00:00:00.000Z'), durationMonths: 12,
    message: null, status: 'PENDING', rejectionReason: null, reviewedAt: null,
    createdAt: new Date('2026-11-14T00:00:00.000Z'),
  });
  assert.equal(result.desiredMoveInDate, '2026-11-20');
});