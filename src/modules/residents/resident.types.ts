import type { ContractStatus, ResidentInvitationStatus } from '../../common/constants/phase3-status';

export type ResidentRole = 'PRIMARY_TENANT' | 'CO_RESIDENT';

export type ResidentRemovalType =
  | 'SELF_LEAVE'
  | 'REMOVED_BY_PRIMARY_TENANT'
  | 'REMOVED_BY_LANDLORD';

export type ParsedInviteIdentifier =
  | { type: 'EMAIL'; value: string }
  | { type: 'PHONE'; value: string };

export interface ResidentInvitationListQuery {
  status?: ResidentInvitationStatus;
  page: number;
  limit: number;
}

export interface UserSummaryDTO {
  id: string;
  fullName: string;
  avatarUrl: string | null;
}

export interface ResidentItemDTO {
  userId: string;
  fullName: string;
  avatarUrl: string | null;
  residentRole: ResidentRole;
  joinedAt: string | null;
}

export interface ContractPendingInvitationDTO {
  invitationId: string;
  status: 'PENDING';
  expiresAt: string;
  invitedUser: UserSummaryDTO;
  invitedBy: UserSummaryDTO;
}

export interface ContractRoomSummaryDTO {
  id: string;
  roomCode: string;
  maxOccupants: number;
  property: {
    id: string;
    name: string;
  };
}

export interface ContractResidentsResponseDTO {
  contractId: string;
  contractStatus: ContractStatus;
  room: ContractRoomSummaryDTO;
  currentOccupants: number;
  maxOccupants: number;
  remainingSlots: number;
  residents: ResidentItemDTO[];
  pendingInvitations: ContractPendingInvitationDTO[] | null;
}

export interface ResidentInvitationCreatedDTO {
  invitationId: string;
  contractId: string;
  status: 'PENDING';
  expiresAt: string;
  invitedUser: UserSummaryDTO;
  invitedBy: UserSummaryDTO;
}

export interface InvitationRoomDetailDTO {
  id: string;
  roomCode: string;
  maxOccupants: number;
  property: {
    id: string;
    name: string;
    address: string;
  };
}

export interface ReceivedResidentInvitationDTO {
  invitationId: string;
  contractId: string;
  status: ResidentInvitationStatus;
  expiresAt: string;
  acceptedAt: string | null;
  room: InvitationRoomDetailDTO;
  invitedBy: UserSummaryDTO;
}

export interface PaginatedResidentInvitationsDTO {
  items: ReceivedResidentInvitationDTO[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface AcceptResidentInvitationDTO {
  invitationId: string;
  contractId: string;
  status: 'ACCEPTED';
  acceptedAt: string;
  resident: ResidentItemDTO;
  currentOccupants: number;
  maxOccupants: number;
}

export interface InvitationStatusActionDTO {
  invitationId: string;
  contractId: string;
  status: 'REJECTED' | 'CANCELLED';
}

export interface RemoveContractResidentDTO {
  contractId: string;
  userId: string;
  leftAt: string;
  removalType: ResidentRemovalType;
  currentOccupants: number;
  maxOccupants: number;
}

export interface UserSummaryRow {
  id: string;
  fullName: string;
  avatarUrl: string | null;
}

export interface ContractResidentsRow {
  id: string;
  status: string;
  activatedAt: Date | null;
  tenant: UserSummaryRow;
  room: {
    id: string;
    roomCode: string;
    maxOccupants: number;
    property: {
      id: string;
      name: string;
    };
  };
  contractResidents: Array<{
    userId: string;
    joinedAt: Date;
    user: UserSummaryRow;
  }>;
  residentInvitations: Array<{
    id: string;
    status: string;
    expiresAt: Date;
    invitedUser: UserSummaryRow;
    invitedBy: UserSummaryRow;
  }>;
}

export interface CreatedInvitationRow {
  id: string;
  contractId: string;
  status: string;
  expiresAt: Date;
  invitedUser: UserSummaryRow;
  invitedBy: UserSummaryRow;
}

export interface ReceivedInvitationRow {
  id: string;
  contractId: string;
  status: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  contract: {
    room: {
      id: string;
      roomCode: string;
      maxOccupants: number;
      property: {
        id: string;
        name: string;
        address: string;
      };
    };
  };
  invitedBy: UserSummaryRow;
}

export interface ContractMutationRow {
  id: string;
  status: string;
  tenantId: string;
  room: {
    id: string;
    roomCode: string;
    maxOccupants: number;
    property: {
      id: string;
      landlordId: string;
    };
  };
}

export interface InviteTargetUserRow extends UserSummaryRow {
  role: string;
  accountStatus: string;
}

export interface ContractResidentRow {
  joinedAt: Date;
  leftAt: Date | null;
  user: {
    id: string;
    fullName: string;
  };
}

export interface LockedInvitationRow {
  id: string;
  contractId: string;
  invitedUserId: string;
  invitedById: string;
  status: string;
  expiresAt: Date;
  invitedUser: UserSummaryRow;
  contract: ContractMutationRow;
}

export interface AcceptedInvitationTxResult {
  invitationId: string;
  contractId: string;
  acceptedAt: Date;
  resident: {
    user: UserSummaryRow;
    joinedAt: Date;
  };
  currentOccupants: number;
  maxOccupants: number;
}

export interface RemovedResidentTxResult {
  contractId: string;
  userId: string;
  leftAt: Date;
  removalType: ResidentRemovalType;
  currentOccupants: number;
  maxOccupants: number;
}

export interface ContractAccessContext {
  contractId: string;
  status: string;
  tenantId: string;
  landlordId: string;
  isPrimaryTenant: boolean;
  isLandlord: boolean;
  isActiveCoResident: boolean;
}

export interface InvitationAccessContext {
  invitationId: string;
  contractId: string;
  invitedUserId: string;
  invitedById: string;
  contractTenantId: string;
  landlordId: string;
}

export type AcceptInvitationOutcome =
  | { outcome: 'EXPIRED' }
  | { outcome: 'ACCEPTED'; data: AcceptedInvitationTxResult };

export type RejectInvitationOutcome =
  | { outcome: 'EXPIRED' }
  | { outcome: 'REJECTED'; data: { invitationId: string; contractId: string } };

export type CancelInvitationOutcome =
  | { outcome: 'EXPIRED' }
  | { outcome: 'CANCELLED'; data: { invitationId: string; contractId: string } };
