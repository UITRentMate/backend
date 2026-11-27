import { Prisma } from '@prisma/client';

import { CONTRACT_STATUS, DEPOSIT_RECEIPT_STATUS, LIVE_CONTRACT_STATUSES } from '../../common/constants/phase3-status';
import { prisma } from '../../infrastructure/database/prisma';

const serviceFees = {
  contractServiceFees: { select: { feeName: true, monthlyAmount: true }, orderBy: [{ feeName: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.ContractInclude;

export type ContractWithFees = Prisma.ContractGetPayload<{ include: typeof serviceFees }>;
export type HoldActor = { id: string; role: string };

export function withHoldTransaction<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { isolationLevel: Prisma.TransactionIsolationLevel },
) {
  return prisma.$transaction(work, options ?? { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

// Các luồng thay đổi giữ chỗ khóa phòng trước và hợp đồng sau.
export async function lockHoldRoom(tx: Prisma.TransactionClient, roomId: string) {
  await tx.$queryRaw`SELECT id FROM rooms WHERE id = ${roomId}::uuid FOR UPDATE`;
}

export async function lockHoldContract(tx: Prisma.TransactionClient, contractId: string) {
  await tx.$queryRaw`SELECT id FROM contracts WHERE id = ${contractId}::uuid FOR UPDATE`;
}

export function findContractRoom(contractId: string, actor: HoldActor, tx: Prisma.TransactionClient) {
  return tx.contract.findFirst({
    where: {
      id: contractId,
      ...(actor.role === 'LANDLORD'
        ? { room: { property: { landlordId: actor.id } } }
        : { tenantId: actor.id }),
    },
    select: { roomId: true },
  });
}

export function findHoldContract(tx: Prisma.TransactionClient, id: string) {
  return tx.contract.findUnique({
    where: { id },
    include: {
      room: { select: { property: { select: { landlordId: true } } } },
      depositReceipts: { where: { status: DEPOSIT_RECEIPT_STATUS.PENDING }, select: { id: true }, take: 1 },
    },
  });
}

export function findOverdueHoldCandidates(now: Date, scope: { roomId?: string; id?: string }) {
  return prisma.contract.findMany({
    where: {
      ...scope,
      OR: [
        {
          status: { in: [CONTRACT_STATUS.DRAFT, CONTRACT_STATUS.PENDING_TENANT_CONFIRMATION] },
          holdExpiresAt: { lte: now },
        },
        {
          status: CONTRACT_STATUS.AWAITING_DEPOSIT,
          depositDeadlineAt: { lte: now },
          depositReceipts: { none: { status: DEPOSIT_RECEIPT_STATUS.PENDING } },
        },
      ],
    },
    select: { id: true, roomId: true },
  });
}

export function findLiveContract(tx: Prisma.TransactionClient, roomId: string) {
  return tx.contract.findFirst({
    where: { roomId, status: { in: [...LIVE_CONTRACT_STATUSES] } },
    select: { id: true },
  });
}

export function createDraftContract(tx: Prisma.TransactionClient, data: Omit<Prisma.ContractUncheckedCreateInput, 'status'>) {
  return tx.contract.create({ data: { ...data, status: CONTRACT_STATUS.DRAFT }, include: serviceFees });
}

export function updateClosedHold(
  tx: Prisma.TransactionClient,
  id: string,
  status: typeof CONTRACT_STATUS.CANCELLED | typeof CONTRACT_STATUS.EXPIRED,
  cancellationReason: string,
) {
  return tx.contract.update({ where: { id }, data: { status, cancellationReason }, include: serviceFees });
}

export function releaseHeldRoom(tx: Prisma.TransactionClient, roomId: string) {
  return tx.room.updateMany({
    where: { id: roomId, occupancyStatus: 'HELD' },
    data: { occupancyStatus: 'VACANT' },
  });
}
