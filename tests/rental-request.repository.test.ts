import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { prisma } from '../src/infrastructure/database/prisma';
import { RentalRequestRepository } from '../src/modules/rental-requests/rental-request.repository';

const undo: Array<() => void> = [];
afterEach(() => { while (undo.length) undo.pop()!(); });
function stub(delegate: any, name: string, implementation: (...args: any[]) => any) {
  const original = delegate[name]; delegate[name] = implementation; undo.push(() => { delegate[name] = original; });
}
const query = { page: 1, pageSize: 10 };

test('tenant and landlord list queries both use an ID tie-breaker', async () => {
  const orderings: unknown[] = [];
  stub(prisma.rentalRequest, 'findMany', async (args: any) => { orderings.push(args.orderBy); return []; });
  stub(prisma.rentalRequest, 'count', async () => 0);
  await RentalRequestRepository.findRequestsByTenant('550e8400-e29b-41d4-a716-446655440001', query);
  await RentalRequestRepository.findRequestsByLandlord('550e8400-e29b-41d4-a716-446655440002', query);
  assert.deepEqual(orderings, [[{ createdAt: 'desc' }, { id: 'desc' }], [{ createdAt: 'desc' }, { id: 'desc' }]]);
});

test('rejectPendingRequest scopes atomic update to PENDING and landlord ownership', async () => {
  let args: any;
  stub(prisma.rentalRequest, 'updateMany', async (input: any) => { args = input; return { count: 1 }; });
  const landlordId = '550e8400-e29b-41d4-a716-446655440002';
  await RentalRequestRepository.rejectPendingRequest('550e8400-e29b-41d4-a716-446655440020', landlordId, 'Not suitable');
  assert.equal(args.where.status, 'PENDING');
  assert.equal(args.where.room.property.landlordId, landlordId);
  assert.equal(args.data.status, 'REJECTED');
});