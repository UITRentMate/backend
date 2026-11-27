import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateDepositAmount, validateDepositRejection } from '../../src/modules/deposits/deposit.validation';

test('số tiền giữ đúng độ chính xác DECIMAL(14,2)', () => {
  assert.equal(validateDepositAmount({ amount: '999999999999.99' }).toFixed(2), '999999999999.99');
  assert.equal(validateDepositAmount({ amount: '0.01' }).toFixed(2), '0.01');
  for (const amount of [undefined, 42, '', '0.00', '-1', '1e4', '1.001', '1000000000000', '1\n']) {
    assert.throws(() => validateDepositAmount({ amount }), { code: 'VALIDATION_ERROR' });
  }
  assert.throws(() => validateDepositAmount({ amount: '1', proofUrl: 'https://example.test' }), { code: 'VALIDATION_ERROR' });
});

test('lý do từ chối phải có 10–1000 ký tự sau khi bỏ khoảng trắng', () => {
  assert.equal(validateDepositRejection({ rejectionReason: '  Chưa nhận tiền  ' }), 'Chưa nhận tiền');
  assert.equal(validateDepositRejection({ rejectionReason: 'x'.repeat(1000) }).length, 1000);
  for (const body of [undefined, {}, { rejectionReason: 'x'.repeat(9) }, { rejectionReason: 'x'.repeat(1001) },
    { rejectionReason: 'Chưa nhận tiền', status: 'CONFIRMED' }]) {
    assert.throws(() => validateDepositRejection(body), { code: 'VALIDATION_ERROR' });
  }
});
