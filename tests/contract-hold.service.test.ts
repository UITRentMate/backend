import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONTRACT_STATUS } from '../src/common/constants/phase3-status';
import { isHoldOverdue } from '../src/modules/contracts/contract.service';

const now = new Date('2026-11-24T09:00:00.000Z');
const earlier = new Date(now.getTime() - 1);
const later = new Date(now.getTime() + 1);

test('Hạn giữ chỗ áp dụng cho DRAFT và PENDING_TENANT_CONFIRMATION từ đúng thời điểm hết hạn', () => {
  for (const status of [CONTRACT_STATUS.DRAFT, CONTRACT_STATUS.PENDING_TENANT_CONFIRMATION]) {
    const hold = { status, holdExpiresAt: now, depositDeadlineAt: null, depositReceipts: [] };
    assert.equal(isHoldOverdue(hold, earlier), false);
    assert.equal(isHoldOverdue(hold, now), true);
    assert.equal(isHoldOverdue(hold, later), true);
    assert.equal(isHoldOverdue({ ...hold, holdExpiresAt: null }, later), false);
  }
});

test('AWAITING_DEPOSIT chỉ dùng hạn cọc và không hết hạn khi có biên lai chờ', () => {
  const hold = {
    status: CONTRACT_STATUS.AWAITING_DEPOSIT,
    holdExpiresAt: earlier,
    depositDeadlineAt: now,
    depositReceipts: [],
  };
  assert.equal(isHoldOverdue(hold, earlier), false);
  assert.equal(isHoldOverdue(hold, now), true);
  assert.equal(isHoldOverdue({ ...hold, depositReceipts: [{ id: 'receipt' }] }, later), false);
  assert.equal(isHoldOverdue({ ...hold, depositDeadlineAt: null }, later), false);
  assert.equal(isHoldOverdue({ ...hold, status: CONTRACT_STATUS.DEPOSIT_CONFIRMED }, later), false);
});
