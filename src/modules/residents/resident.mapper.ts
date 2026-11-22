import type {
  ContractStatus,
  ResidentInvitationStatus,
} from '../../common/constants/phase3-status';
import type {
  AcceptResidentInvitationDTO,
  AcceptedInvitationTxResult,
  ContractPendingInvitationDTO,
  ContractResidentsResponseDTO,
  ContractResidentsRow,
  CreatedInvitationRow,
  InvitationStatusActionDTO,
  ReceivedInvitationRow,
  ReceivedResidentInvitationDTO,
  RemoveContractResidentDTO,
  RemovedResidentTxResult,
  ResidentInvitationCreatedDTO,
  ResidentItemDTO,
  UserSummaryDTO,
  UserSummaryRow,
} from './resident.types';

/**
 * Ánh xạ User theo nguyên tắc Privacy-by-Default (chỉ trả id, fullName, avatarUrl).
 */
export function mapUserSummary(user: UserSummaryRow): UserSummaryDTO {
  return {
    id: user.id,
    fullName: user.fullName,
    avatarUrl: user.avatarUrl ?? null,
  };
}

export function mapContractResidentsResponse(
  row: ContractResidentsRow,
  includePendingInvitations: boolean,
): ContractResidentsResponseDTO {
  const primaryResident: ResidentItemDTO = {
    userId: row.tenant.id,
    fullName: row.tenant.fullName,
    avatarUrl: row.tenant.avatarUrl ?? null,
    residentRole: 'PRIMARY_TENANT',
    joinedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
  };

  const coResidents: ResidentItemDTO[] = row.contractResidents.map((item) => ({
    userId: item.user.id,
    fullName: item.user.fullName,
    avatarUrl: item.user.avatarUrl ?? null,
    residentRole: 'CO_RESIDENT',
    joinedAt: item.joinedAt.toISOString(),
  }));

  const currentOccupants = 1 + coResidents.length;
  const maxOccupants = row.room.maxOccupants;
  const remainingSlots = Math.max(0, maxOccupants - currentOccupants);

  const pendingInvitations: ContractPendingInvitationDTO[] | null = includePendingInvitations
    ? row.residentInvitations.map((invitation) => ({
        invitationId: invitation.id,
        status: 'PENDING',
        expiresAt: invitation.expiresAt.toISOString(),
        invitedUser: mapUserSummary(invitation.invitedUser),
        invitedBy: mapUserSummary(invitation.invitedBy),
      }))
    : null;

  return {
    contractId: row.id,
    contractStatus: row.status as ContractStatus,
    room: {
      id: row.room.id,
      roomCode: row.room.roomCode,
      maxOccupants: row.room.maxOccupants,
      property: {
        id: row.room.property.id,
        name: row.room.property.name,
      },
    },
    currentOccupants,
    maxOccupants,
    remainingSlots,
    residents: [primaryResident, ...coResidents],
    pendingInvitations,
  };
}

export function mapCreatedInvitationResponse(
  row: CreatedInvitationRow,
): ResidentInvitationCreatedDTO {
  return {
    invitationId: row.id,
    contractId: row.contractId,
    status: 'PENDING',
    expiresAt: row.expiresAt.toISOString(),
    invitedUser: mapUserSummary(row.invitedUser),
    invitedBy: mapUserSummary(row.invitedBy),
  };
}

export function mapReceivedInvitationItem(
  row: ReceivedInvitationRow,
): ReceivedResidentInvitationDTO {
  return {
    invitationId: row.id,
    contractId: row.contractId,
    status: row.status as ResidentInvitationStatus,
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
    room: {
      id: row.contract.room.id,
      roomCode: row.contract.room.roomCode,
      maxOccupants: row.contract.room.maxOccupants,
      property: {
        id: row.contract.room.property.id,
        name: row.contract.room.property.name,
        address: row.contract.room.property.address,
      },
    },
    invitedBy: mapUserSummary(row.invitedBy),
  };
}

export function mapAcceptInvitationResponse(
  result: AcceptedInvitationTxResult,
): AcceptResidentInvitationDTO {
  return {
    invitationId: result.invitationId,
    contractId: result.contractId,
    status: 'ACCEPTED',
    acceptedAt: result.acceptedAt.toISOString(),
    resident: {
      userId: result.resident.user.id,
      fullName: result.resident.user.fullName,
      avatarUrl: result.resident.user.avatarUrl ?? null,
      residentRole: 'CO_RESIDENT',
      joinedAt: result.resident.joinedAt.toISOString(),
    },
    currentOccupants: result.currentOccupants,
    maxOccupants: result.maxOccupants,
  };
}

export function mapInvitationStatusActionResponse(
  invitationId: string,
  contractId: string,
  status: 'REJECTED' | 'CANCELLED',
): InvitationStatusActionDTO {
  return {
    invitationId,
    contractId,
    status,
  };
}

export function mapRemoveResidentResponse(
  result: RemovedResidentTxResult,
): RemoveContractResidentDTO {
  return {
    contractId: result.contractId,
    userId: result.userId,
    leftAt: result.leftAt.toISOString(),
    removalType: result.removalType,
    currentOccupants: result.currentOccupants,
    maxOccupants: result.maxOccupants,
  };
}
