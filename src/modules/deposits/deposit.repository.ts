import { Prisma } from '@prisma/client';

import { DEPOSIT_RECEIPT_STATUS } from '../../common/constants/phase3-status';
import { ApiError } from '../../common/errors/api-error';
import { prisma } from '../../infrastructure/database/prisma';

export { lockHoldContract, withHoldTransaction } from '../contracts/contract.repository';

const receiptSelect = {
  id: true, contractId: true, amount: true, proofUrl: true, status: true, submittedAt: true,
  confirmedById: true, confirmedAt: true, rejectionReason: true,
} satisfies Prisma.DepositReceiptSelect;

export type ReceiptRow = Prisma.DepositReceiptGetPayload<{ select: typeof receiptSelect }>;

const contractSelect = {
  tenantId: true, status: true, depositSnapshot: true, depositDeadlineAt: true,
  room: { select: { property: { select: { landlordId: true } } } },
} satisfies Prisma.ContractSelect;

export function findTenantDepositContract(contractId: string, tenantId: string, db: Prisma.TransactionClient = prisma) {
  return db.contract.findFirst({
    where: { id: contractId, tenantId },
    select: {
      ...contractSelect,
      depositReceipts: { where: { status: DEPOSIT_RECEIPT_STATUS.PENDING }, select: { id: true }, take: 1 },
    },
  });
}

export function findDepositHistory(contractId: string, actor: { id: string; role: string }) {
  return prisma.contract.findFirst({
    where: {
      id: contractId,
      ...(actor.role === 'LANDLORD' ? landlordContract(actor.id) : { tenantId: actor.id }),
    },
    select: {
      depositReceipts: { select: receiptSelect, orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }] },
    },
  });
}

function landlordContract(landlordId: string): Prisma.ContractWhereInput {
  return { room: { property: { landlordId } } };
}

export function findLandlordReceipt(tx: Prisma.TransactionClient, receiptId: string, landlordId: string) {
  return tx.depositReceipt.findFirst({
    where: { id: receiptId, contract: landlordContract(landlordId) },
    select: { ...receiptSelect, contract: { select: contractSelect } },
  });
}

export async function createPendingReceipt(
  tx: Prisma.TransactionClient, contractId: string, amount: Prisma.Decimal, proofUrl: string,
) {
  try {
    return await tx.depositReceipt.create({
      data: { contractId, amount, proofUrl, status: DEPOSIT_RECEIPT_STATUS.PENDING },
      select: receiptSelect,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = error.meta?.target;
      if (target === 'uq_deposit_receipts_pending_contract'
        || (Array.isArray(target) && target.length === 1 && target[0] === 'contract_id')) {
        throw pendingDepositConflict();
      }
    }
    throw error;
  }
}

export function pendingDepositConflict() {
  return new ApiError(409, 'DEPOSIT_RECEIPT_ALREADY_PENDING', 'Hợp đồng đã có biên nhận đang chờ đối soát');
}

export function updateDepositReceipt(
  tx: Prisma.TransactionClient, receiptId: string,
  data: Pick<Prisma.DepositReceiptUncheckedUpdateInput, 'status' | 'confirmedById' | 'confirmedAt' | 'rejectionReason'>,
) {
  return tx.depositReceipt.update({ where: { id: receiptId }, data, select: receiptSelect });
}

export function updateDepositContract(
  tx: Prisma.TransactionClient, contractId: string,
  data: Pick<Prisma.ContractUpdateInput, 'status' | 'depositDeadlineAt'>,
) {
  return tx.contract.update({ where: { id: contractId }, data, select: { status: true, depositDeadlineAt: true } });
}
