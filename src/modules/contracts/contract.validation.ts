import { z } from 'zod';

import { ApiError } from '../../common/errors/api-error';

const cancelHoldSchema = z.strictObject({
  reason: z.string().trim().min(10).max(500),
});

export function validateCancelContractHold(contractId: unknown, body: unknown) {
  const id = z.uuid().safeParse(contractId);
  if (!id.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Mã hợp đồng phải là UUID hợp lệ');
  }
  const input = cancelHoldSchema.safeParse(body);
  if (!input.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Cần cung cấp lý do hủy giữ chỗ từ 10 đến 500 ký tự');
  }
  return { contractId: id.data, reason: input.data.reason };
}
