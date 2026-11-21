import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ApiError } from '../src/common/errors/api-error';
import { RentalRequestRepository } from '../src/modules/rental-requests/rental-request.repository';
import { RentalRequestService } from '../src/modules/rental-requests/rental-request.service';

const undo: Array<() => void> = [];
afterEach(() => { while (undo.length) undo.pop()!(); });
function stub(delegate: any, name: string, implementation: (...args: any[]) => any) {
  const original = delegate[name]; delegate[name] = implementation; undo.push(() => { delegate[name] = original; });
}
const requestId = '550e8400-e29b-41d4-a716-446655440020';
const landlordId = '550e8400-e29b-41d4-a716-446655440002';

test('getRentalRequestDetail returns scoped 404 for inaccessible request', async () => {
  stub(RentalRequestRepository, 'findDetailById', async () => null);
  await assert.rejects(() => RentalRequestService.getRentalRequestDetail({ id: 'other', role: 'TENANT' }, requestId),
    (error: unknown) => error instanceof ApiError && error.statusCode === 404 && error.code === 'RENTAL_REQUEST_NOT_FOUND');
});

test('rejectRentalRequest returns 409 when the request is no longer PENDING', async () => {
  stub(RentalRequestRepository, 'rejectPendingRequest', async () => ({ count: 0, reviewedAt: new Date() }));
  stub(RentalRequestRepository, 'findLandlordRentalRequestById', async () => ({ id: requestId, status: 'REJECTED', rejectionReason: 'Existing', reviewedAt: new Date() }));
  await assert.rejects(() => RentalRequestService.rejectRentalRequest(landlordId, requestId, { reason: 'Again' }),
    (error: unknown) => error instanceof ApiError && error.statusCode === 409 && error.code === 'INVALID_STATUS_TRANSITION');
});