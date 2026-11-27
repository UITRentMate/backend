import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';

import {
  CONTRACT_STATUS, DEPOSIT_RECEIPT_STATUS, NOTIFICATION_EVENT_TYPE, PHASE3_TIME_LIMITS_MS,
} from '../../common/constants/phase3-status';
import { ApiError } from '../../common/errors/api-error';
import { recordAuditLog } from '../../common/utils/audit-log.util';
import { createNotification } from '../../common/utils/notification.util';
import { expireHoldForContract } from '../contracts/contract.service';
import { mediaService } from '../media/media.service';
import type { UploadResult } from '../media/media.types';
import {
  createPendingReceipt, findDepositHistory, findLandlordReceipt, findTenantDepositContract,
  lockHoldContract, pendingDepositConflict, updateDepositContract, updateDepositReceipt,
  withHoldTransaction, type ReceiptRow,
} from './deposit.repository';

type DepositContract = NonNullable<Awaited<ReturnType<typeof findTenantDepositContract>>>;

function toReceiptDto(receipt: ReceiptRow) {
  return {
    ...receipt,
    amount: receipt.amount.toFixed(2),
    submittedAt: receipt.submittedAt.toISOString(),
    confirmedAt: receipt.confirmedAt?.toISOString() ?? null,
  };
}

function contractNotFound() {
  return new ApiError(404, 'NOT_FOUND', 'Không tìm thấy hợp đồng');
}

function invalidContractStatus() {
  return new ApiError(409, 'INVALID_CONTRACT_STATUS', 'Trạng thái hợp đồng không cho phép thao tác với tiền cọc');
}

function assertCanSubmit(contract: DepositContract | null, amount: Prisma.Decimal, now: Date) {
  if (!contract) throw contractNotFound();
  const { status, depositDeadlineAt } = contract;
  if (status === CONTRACT_STATUS.EXPIRED && depositDeadlineAt && depositDeadlineAt <= now) {
    throw new ApiError(409, 'DEPOSIT_DEADLINE_EXPIRED', 'Hợp đồng đã quá hạn nộp tiền cọc');
  }
  if (status !== CONTRACT_STATUS.AWAITING_DEPOSIT || !depositDeadlineAt) throw invalidContractStatus();
  if (contract.depositReceipts.length) throw pendingDepositConflict();
  if (depositDeadlineAt <= now) {
    throw new ApiError(409, 'DEPOSIT_DEADLINE_EXPIRED', 'Hợp đồng đã quá hạn nộp tiền cọc');
  }
  if (amount.lt(contract.depositSnapshot)) {
    throw new ApiError(400, 'INSUFFICIENT_DEPOSIT_AMOUNT', 'Số tiền phải đạt mức tiền cọc của hợp đồng');
  }
  return contract;
}

export async function submitDepositReceipt(tenantId: string, contractId: string, amount: Prisma.Decimal, proof: Buffer) {
  // Kiểm tra quyền trước khi lazy-expire vì tác vụ hết hạn có thể ghi dữ liệu.
  if (!(await findTenantDepositContract(contractId, tenantId))) throw contractNotFound();
  const checkedAt = new Date();
  await expireHoldForContract(contractId, checkedAt);
  assertCanSubmit(await findTenantDepositContract(contractId, tenantId), amount, checkedAt);

  let uploaded: UploadResult;
  try {
    uploaded = await mediaService.uploadStream(proof, {
      publicId: randomUUID(), folder: `rentmate/deposits/${contractId}`,
    });
  } catch (error) {
    const httpStatus = typeof error === 'object' && error !== null && 'http_code' in error
      && typeof error.http_code === 'number' ? error.http_code : undefined;
    console.error('[Deposits] Tải ảnh biên nhận lên Cloudinary thất bại', { contractId, httpStatus });
    throw new ApiError(502, 'CLOUDINARY_UPLOAD_FAILED', 'Không thể lưu ảnh biên nhận');
  }

  let receipt: ReceiptRow;
  try {
    receipt = await withHoldTransaction(async (tx) => {
      // Upload ở ngoài giao dịch. Đọc lại quyền, trạng thái và thời hạn sau khi lấy khóa.
      await lockHoldContract(tx, contractId);
      const contract = assertCanSubmit(await findTenantDepositContract(contractId, tenantId, tx), amount, new Date());
      const pending = await createPendingReceipt(tx, contractId, amount, uploaded.secureUrl);
      await createNotification(tx, {
        recipientId: contract.room.property.landlordId,
        title: 'Có biên nhận tiền cọc mới',
        eventType: NOTIFICATION_EVENT_TYPE.DEPOSIT_RECEIPT_SUBMITTED,
        payload: {
          content: 'Người thuê đã gửi biên nhận tiền cọc để đối soát.',
          actionUrl: `/landlord/contracts/${contractId}`,
          relatedEntityType: 'DEPOSIT_RECEIPT',
          relatedEntityId: pending.id,
        },
      });
      return pending;
    });
  } catch (error) {
    if (!(await mediaService.deleteResource(uploaded.publicId))) {
      console.warn('[Deposits] Không thể xóa ảnh biên nhận sau khi giao dịch thất bại', { publicId: uploaded.publicId });
    }
    if (error instanceof ApiError && error.code === 'DEPOSIT_DEADLINE_EXPIRED') {
      // Dùng luồng chuẩn để khóa phòng trước hợp đồng và commit việc hết hạn độc lập.
      try {
        await expireHoldForContract(contractId);
      } catch {
        console.warn('[Deposits] Không thể cập nhật hợp đồng hết hạn sau khi nộp biên nhận', { contractId });
      }
    }
    throw error;
  }
  return toReceiptDto(receipt);
}

export async function listDepositReceipts(actor: { id: string; role: string }, contractId: string) {
  const history = await findDepositHistory(contractId, actor);
  if (!history) throw contractNotFound();
  return { items: history.depositReceipts.map(toReceiptDto) };
}

function rejectionDeadline(deadline: Date | null, now: Date) {
  const graceDeadline = new Date(now.getTime() + PHASE3_TIME_LIMITS_MS.DEPOSIT_REJECT_GRACE_MS);
  return deadline && deadline >= graceDeadline ? deadline : graceDeadline;
}

export function reviewDepositReceipt(landlordId: string, receiptId: string, review: { rejectionReason?: string }) {
  return withHoldTransaction(async (tx) => {
    const notFound = new ApiError(404, 'NOT_FOUND', 'Không tìm thấy biên nhận tiền cọc');
    const candidate = await findLandlordReceipt(tx, receiptId, landlordId);
    if (!candidate) throw notFound;
    await lockHoldContract(tx, candidate.contractId);
    const current = await findLandlordReceipt(tx, receiptId, landlordId);
    if (!current || current.contractId !== candidate.contractId) throw notFound;
    if (current.status !== DEPOSIT_RECEIPT_STATUS.PENDING) {
      throw new ApiError(409, 'INVALID_DEPOSIT_RECEIPT_STATUS', 'Chỉ đối soát biên nhận đang chờ xử lý');
    }
    if (current.contract.status !== CONTRACT_STATUS.AWAITING_DEPOSIT) throw invalidContractStatus();

    const now = new Date();
    const rejected = review.rejectionReason !== undefined;
    const status = rejected ? DEPOSIT_RECEIPT_STATUS.REJECTED : DEPOSIT_RECEIPT_STATUS.CONFIRMED;
    const eventType = rejected ? NOTIFICATION_EVENT_TYPE.DEPOSIT_REJECTED : NOTIFICATION_EVENT_TYPE.DEPOSIT_CONFIRMED;
    const oldDeadline = current.contract.depositDeadlineAt;
    const depositDeadlineAt = rejected ? rejectionDeadline(oldDeadline, now) : oldDeadline;
    const contractStatus = rejected ? CONTRACT_STATUS.AWAITING_DEPOSIT : CONTRACT_STATUS.DEPOSIT_CONFIRMED;
    const receipt = await updateDepositReceipt(tx, receiptId, {
      status, confirmedById: landlordId, confirmedAt: now, rejectionReason: review.rejectionReason ?? null,
    });
    if (!rejected || depositDeadlineAt !== oldDeadline) {
      await updateDepositContract(tx, current.contractId, { status: contractStatus, depositDeadlineAt });
    }

    await recordAuditLog(tx, {
      actorId: landlordId,
      entityType: 'DEPOSIT_RECEIPT',
      entityId: receiptId,
      action: eventType,
      oldData: { status: current.status, contractStatus: current.contract.status, depositDeadlineAt: oldDeadline?.toISOString() ?? null },
      newData: {
        contractId: current.contractId, amount: receipt.amount.toFixed(2), proofUrl: receipt.proofUrl,
        oldStatus: current.status, newStatus: receipt.status, contractStatus,
        depositDeadlineAt: depositDeadlineAt?.toISOString() ?? null, rejectionReason: receipt.rejectionReason,
      },
    });
    await createNotification(tx, {
      recipientId: current.contract.tenantId,
      title: rejected ? 'Biên nhận tiền cọc bị từ chối' : 'Đã xác nhận tiền cọc',
      eventType,
      payload: {
        content: review.rejectionReason ?? 'Chủ trọ đã xác nhận nhận đủ tiền cọc.',
        actionUrl: `/contracts/${current.contractId}`,
        relatedEntityType: 'DEPOSIT_RECEIPT',
        relatedEntityId: receiptId,
      },
    });
    return { receipt: toReceiptDto(receipt), contractStatus, depositDeadlineAt: depositDeadlineAt?.toISOString() ?? null };
  });
}
