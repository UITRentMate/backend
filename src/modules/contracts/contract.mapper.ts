import type { ContractWithFees } from './contract.repository';

export function mapToContract(contract: ContractWithFees) {
  return {
    id: contract.id,
    roomId: contract.roomId,
    tenantId: contract.tenantId,
    rentalRequestId: contract.rentalRequestId,
    startDate: contract.startDate.toISOString().slice(0, 10),
    endDate: contract.endDate.toISOString().slice(0, 10),
    status: contract.status,
    rentSnapshot: contract.rentSnapshot.toNumber(),
    depositSnapshot: contract.depositSnapshot.toNumber(),
    electricityRate: contract.electricityRate.toNumber(),
    waterRate: contract.waterRate.toNumber(),
    holdExpiresAt: contract.holdExpiresAt?.toISOString() ?? null,
    depositDeadlineAt: contract.depositDeadlineAt?.toISOString() ?? null,
    cancellationReason: contract.cancellationReason,
    serviceFees: contract.contractServiceFees.map(({ feeName, monthlyAmount }) => ({
      feeName,
      monthlyAmount: monthlyAmount.toNumber(),
    })),
  };
}
