import type { Prisma } from '@prisma/client';

import {
  CANCELLABLE_HOLD_CONTRACT_STATUSES, CONTRACT_STATUS, NOTIFICATION_EVENT_TYPE,
} from '../../common/constants/phase3-status';
import { ApiError } from '../../common/errors/api-error';
import { recordAuditLog } from '../../common/utils/audit-log.util';
import { createNotificationsBatch } from '../../common/utils/notification.util';
import {
  findContractRoom, findHoldContract, findLiveContract, findOverdueHoldCandidates, lockHoldContract,
  lockHoldRoom, releaseHeldRoom, updateClosedHold, withHoldTransaction, type HoldActor,
} from './contract.repository';
import { mapToContract } from './contract.mapper';

type HoldContract = NonNullable<Awaited<ReturnType<typeof findHoldContract>>>;
const expiryReason = 'Tự động hết hạn giữ chỗ do quá thời hạn quy định';

export function isHoldOverdue(contract: Pick<HoldContract,
  'status' | 'holdExpiresAt' | 'depositDeadlineAt' | 'depositReceipts'>, now: Date): boolean {
  if (contract.status === CONTRACT_STATUS.AWAITING_DEPOSIT) {
    return contract.depositDeadlineAt !== null
      && contract.depositDeadlineAt <= now
      && contract.depositReceipts.length === 0;
  }
  return (contract.status === CONTRACT_STATUS.DRAFT || contract.status === CONTRACT_STATUS.PENDING_TENANT_CONFIRMATION)
    && contract.holdExpiresAt !== null
    && contract.holdExpiresAt <= now;
}

async function closeHold(
  tx: Prisma.TransactionClient,
  contract: HoldContract,
  reason: string,
  actor?: HoldActor,
) {
  const landlordId = contract.room.property.landlordId;
  const status = actor ? CONTRACT_STATUS.CANCELLED : CONTRACT_STATUS.EXPIRED;
  const action = actor ? NOTIFICATION_EVENT_TYPE.CONTRACT_HOLD_CANCELLED : NOTIFICATION_EVENT_TYPE.CONTRACT_HOLD_EXPIRED;
  const updated = await updateClosedHold(tx, contract.id, status, reason);
  if (!(await findLiveContract(tx, contract.roomId))) {
    await releaseHeldRoom(tx, contract.roomId);
  }
  await recordAuditLog(tx, {
    actorId: actor?.id,
    entityType: 'CONTRACT',
    entityId: contract.id,
    action,
    oldData: { status: contract.status },
    newData: { status, roomId: contract.roomId, cancellationReason: reason },
  });

  const recipients = actor
    ? [actor.role === 'LANDLORD' ? contract.tenantId : landlordId]
    : [contract.tenantId, landlordId];
  await createNotificationsBatch(tx, recipients.map((recipientId) => ({
    recipientId,
    title: actor ? 'Đã hủy giữ chỗ' : 'Đã hết hạn giữ chỗ',
    eventType: action,
    payload: {
      content: reason,
      actionUrl: recipientId === landlordId ? `/landlord/contracts/${contract.id}` : `/contracts/${contract.id}`,
      relatedEntityType: 'CONTRACT',
      relatedEntityId: contract.id,
    },
  })));
  return updated;
}

export async function cancelContractHold(actor: HoldActor, contractId: string, reason: string) {
  return withHoldTransaction(async (tx) => {
    const room = await findContractRoom(contractId, actor, tx);
    const notFound = new ApiError(404, 'NOT_FOUND', 'Không tìm thấy hợp đồng');
    if (!room) throw notFound;
    await lockHoldRoom(tx, room.roomId);
    await lockHoldContract(tx, contractId);
    const contract = await findHoldContract(tx, contractId);
    if (!contract || (actor.role === 'LANDLORD'
      ? contract.room.property.landlordId !== actor.id
      : contract.tenantId !== actor.id)) throw notFound;

    if (contract.status === CONTRACT_STATUS.DEPOSIT_CONFIRMED || contract.status === CONTRACT_STATUS.ACTIVE) {
      throw new ApiError(409, 'CANNOT_CANCEL_AFTER_DEPOSIT_CONFIRMED', 'Không thể hủy giữ chỗ sau khi xác nhận cọc');
    }
    if (!CANCELLABLE_HOLD_CONTRACT_STATUSES.some((status) => status === contract.status)) {
      throw new ApiError(409, 'INVALID_CONTRACT_STATUS', 'Trạng thái hợp đồng không cho phép hủy giữ chỗ');
    }
    if (actor.role === 'LANDLORD' && contract.status === CONTRACT_STATUS.AWAITING_DEPOSIT
      && contract.depositReceipts.length > 0) {
      throw new ApiError(409, 'PENDING_DEPOSIT_RECEIPT_EXISTS', 'Cần xử lý biên lai cọc đang chờ trước khi hủy giữ chỗ');
    }

    return mapToContract(await closeHold(tx, contract, reason, actor));
  });
}

async function expireHolds(scope: { roomId?: string; id?: string }, now: Date) {
  const candidates = await findOverdueHoldCandidates(now, scope);
  let expired = 0;
  for (const candidate of candidates) {
    const changed = await withHoldTransaction(async (tx) => {
      await lockHoldRoom(tx, candidate.roomId);
      await lockHoldContract(tx, candidate.id);
      const contract = await findHoldContract(tx, candidate.id);
      if (!contract || contract.roomId !== candidate.roomId || !isHoldOverdue(contract, now)) return false;
      await closeHold(tx, contract, expiryReason);
      return true;
    });
    if (changed) expired += 1;
  }
  return expired;
}

export function expireOverdueHeldContracts(now = new Date()) {
  return expireHolds({}, now);
}

export async function expireHoldForRoom(roomId: string, now = new Date()) {
  return (await expireHolds({ roomId }, now)) > 0;
}

export async function expireHoldForContract(contractId: string, now = new Date()) {
  return (await expireHolds({ id: contractId }, now)) > 0;
}
