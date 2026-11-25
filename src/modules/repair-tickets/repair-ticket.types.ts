import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  RepairAttachmentStage,
  RepairCostBearer,
  RepairTicketPriority,
  RepairTicketStatus,
} from '../../common/constants/phase3-status';

export type PrismaDbClient = PrismaClient | Prisma.TransactionClient;

export interface CreateRepairTicketInput {
  roomId?: string;
  propertyId?: string;
  title: string;
  description: string;
  priority: RepairTicketPriority;
}

export interface RepairTicketListQuery {
  status?: RepairTicketStatus;
  priority?: RepairTicketPriority;
  propertyId?: string;
  roomId?: string;
  page: number;
  limit: number;
}

export interface AcceptRepairTicketInput {
  resolutionPlan: string;
  scheduledAt: Date;
}

export interface CompleteRepairTicketInput {
  repairCost?: number;
  costBearer?: RepairCostBearer;
}

export interface RejectRepairCompletionInput {
  reason: string;
}

export interface UserSummaryDTO {
  id: string;
  fullName: string;
  avatarUrl: string | null;
}

export interface RepairPropertySummaryDTO {
  id: string;
  name: string;
  address: string;
}

export interface RepairRoomSummaryDTO {
  id: string;
  roomCode: string;
}

export interface RepairAttachmentDTO {
  id: string;
  fileUrl: string;
  stage: RepairAttachmentStage;
  reason: string | null;
  uploadedBy: UserSummaryDTO;
}

export interface RepairAttachmentsByStageDTO {
  INITIAL: RepairAttachmentDTO[];
  COMPLETION: RepairAttachmentDTO[];
  REOPEN_EVIDENCE: RepairAttachmentDTO[];
}

export interface RepairReopenHistoryItemDTO {
  actorId: string | null;
  reason: string;
  reopenedAt: string;
  attachmentCount: number;
}

export interface RepairTicketListItemDTO {
  id: string;
  property: RepairPropertySummaryDTO;
  room: RepairRoomSummaryDTO | null;
  createdBy: UserSummaryDTO;
  title: string;
  priority: RepairTicketPriority;
  status: RepairTicketStatus;
  scheduledAt: string | null;
  completedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  canEscalateToComplaint: boolean;
  autoCloseAt: string | null;
  attachmentCount: number;
  thumbnailUrl: string | null;
}

export interface RepairTicketDetailDTO {
  id: string;
  property: RepairPropertySummaryDTO;
  room: RepairRoomSummaryDTO | null;
  createdBy: UserSummaryDTO;
  title: string;
  description: string;
  priority: RepairTicketPriority;
  status: RepairTicketStatus;
  resolutionPlan: string | null;
  repairCost: number | null;
  costBearer: RepairCostBearer | null;
  scheduledAt: string | null;
  completedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  canEscalateToComplaint: boolean;
  autoCloseAt: string | null;
  latestRejectionReason: string | null;
  reopenHistory: RepairReopenHistoryItemDTO[];
  attachments: RepairAttachmentDTO[];
  attachmentsByStage: RepairAttachmentsByStageDTO;
}

export interface PaginatedRepairTicketsDTO {
  items: RepairTicketListItemDTO[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface UploadedRepairAttachment {
  id: string;
  fileUrl: string;
  publicId: string;
}

export interface AutoCloseBatchResult {
  scanned: number;
  closedCount: number;
  skippedCount: number;
  failedCount: number;
}

export interface UserSummaryRow {
  id: string;
  fullName: string;
  avatarUrl: string | null;
}

export interface RepairTicketListRow {
  id: string;
  title: string;
  priority: string;
  status: string;
  scheduledAt: Date | null;
  completedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  property: {
    id: string;
    name: string;
    address: string;
  };
  room: {
    id: string;
    roomCode: string;
  } | null;
  createdBy: UserSummaryRow;
  attachments: Array<{
    id: string;
    fileUrl: string;
    stage: string;
  }>;
  _count?: {
    attachments: number;
  };
}

export type DecimalLike = Prisma.Decimal | { toNumber(): number } | number | string;

export interface RepairTicketDetailRow {
  id: string;
  propertyId: string;
  roomId: string | null;
  createdById: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  resolutionPlan: string | null;
  repairCost: DecimalLike | null;
  costBearer: string | null;
  scheduledAt: Date | null;
  completedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  property: {
    id: string;
    name: string;
    address: string;
  };
  room: {
    id: string;
    roomCode: string;
  } | null;
  createdBy: UserSummaryRow;
  attachments: Array<{
    id: string;
    fileUrl: string;
    stage: string;
    reason: string | null;
    uploadedBy: UserSummaryRow;
  }>;
}

export interface RepairTicketMutationRow {
  id: string;
  propertyId: string;
  roomId: string | null;
  createdById: string;
  title: string;
  status: string;
  resolutionPlan: string | null;
  repairCost: DecimalLike | null;
  costBearer: string | null;
  scheduledAt: Date | null;
  completedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  property: {
    id: string;
    landlordId: string;
  };
}

export interface ReopenAuditLogRow {
  actorId: string | null;
  newData: unknown;
  createdAt: Date;
}

export interface ActiveResidencyMatch {
  contractId: string;
  roomId: string;
  propertyId: string;
  landlordId: string;
}

export interface CreateTicketRepoInput {
  id: string;
  propertyId: string;
  roomId: string | null;
  createdById: string;
  title: string;
  description: string;
  priority: RepairTicketPriority;
  status: RepairTicketStatus;
  attachments: Array<{
    id: string;
    uploadedById: string;
    fileUrl: string;
    stage: RepairAttachmentStage;
    reason?: string | null;
  }>;
}
