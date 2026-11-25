import {
  PHASE3_TIME_LIMITS_MS,
  REPAIR_ATTACHMENT_STAGE,
  REPAIR_TICKET_STATUS,
  type RepairAttachmentStage,
  type RepairCostBearer,
  type RepairTicketPriority,
  type RepairTicketStatus,
} from '../../common/constants/phase3-status';
import type {
  DecimalLike,
  ReopenAuditLogRow,
  RepairAttachmentDTO,
  RepairAttachmentsByStageDTO,
  RepairReopenHistoryItemDTO,
  RepairTicketDetailDTO,
  RepairTicketDetailRow,
  RepairTicketListItemDTO,
  RepairTicketListRow,
  UserSummaryDTO,
  UserSummaryRow,
} from './repair-ticket.types';

function toNullableNumber(val: DecimalLike | null | undefined): number | null {
  if (val === null || val === undefined) {
    return null;
  }
  if (typeof val === 'number') {
    return val;
  }
  if (typeof val === 'object' && typeof val.toNumber === 'function') {
    return val.toNumber();
  }
  const parsed = Number(val);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapUserSummary(user: UserSummaryRow): UserSummaryDTO {
  return {
    id: user.id,
    fullName: user.fullName,
    avatarUrl: user.avatarUrl ?? null,
  };
}

export function computeCanEscalateToComplaint(
  status: string,
  createdAt: Date,
  now: Date = new Date(),
): boolean {
  return (
    status === REPAIR_TICKET_STATUS.OPEN &&
    now.getTime() - createdAt.getTime() >= PHASE3_TIME_LIMITS_MS.REPAIR_ESCALATION_WAIT_MS
  );
}

export function computeAutoCloseAt(status: string, completedAt: Date | null): string | null {
  if (status !== REPAIR_TICKET_STATUS.AWAITING_CONFIRMATION || !completedAt) {
    return null;
  }
  return new Date(
    completedAt.getTime() + PHASE3_TIME_LIMITS_MS.REPAIR_AUTO_CLOSE_WAIT_MS,
  ).toISOString();
}

export function mapRepairTicketListItem(
  row: RepairTicketListRow,
  now: Date = new Date(),
): RepairTicketListItemDTO {
  const initialAttachment = row.attachments.find(
    (item) => item.stage === REPAIR_ATTACHMENT_STAGE.INITIAL,
  );
  const thumbnailUrl = initialAttachment?.fileUrl ?? row.attachments[0]?.fileUrl ?? null;

  return {
    id: row.id,
    property: {
      id: row.property.id,
      name: row.property.name,
      address: row.property.address,
    },
    room: row.room
      ? {
          id: row.room.id,
          roomCode: row.room.roomCode,
        }
      : null,
    createdBy: mapUserSummary(row.createdBy),
    title: row.title,
    priority: row.priority as RepairTicketPriority,
    status: row.status as RepairTicketStatus,
    scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    canEscalateToComplaint: computeCanEscalateToComplaint(row.status, row.createdAt, now),
    autoCloseAt: computeAutoCloseAt(row.status, row.completedAt),
    attachmentCount: row._count?.attachments ?? row.attachments.length,
    thumbnailUrl,
  };
}

function mapReopenHistory(logs: readonly ReopenAuditLogRow[]): RepairReopenHistoryItemDTO[] {
  const sorted = [...logs].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  return sorted.map((log) => {
    const data =
      log.newData && typeof log.newData === 'object' && !Array.isArray(log.newData)
        ? (log.newData as Record<string, unknown>)
        : {};
    const reason = typeof data.reason === 'string' ? data.reason : '';
    const attachmentCount =
      typeof data.attachmentCount === 'number' && Number.isFinite(data.attachmentCount)
        ? data.attachmentCount
        : 0;

    return {
      actorId: log.actorId ?? null,
      reason,
      reopenedAt: log.createdAt.toISOString(),
      attachmentCount,
    };
  });
}

export function mapRepairTicketDetail(
  row: RepairTicketDetailRow,
  reopenLogs: readonly ReopenAuditLogRow[],
  now: Date = new Date(),
): RepairTicketDetailDTO {
  const attachments: RepairAttachmentDTO[] = row.attachments.map((att) => ({
    id: att.id,
    fileUrl: att.fileUrl,
    stage: att.stage as RepairAttachmentStage,
    reason: att.reason ?? null,
    uploadedBy: mapUserSummary(att.uploadedBy),
  }));

  const attachmentsByStage: RepairAttachmentsByStageDTO = {
    INITIAL: [],
    COMPLETION: [],
    REOPEN_EVIDENCE: [],
  };

  for (const att of attachments) {
    if (att.stage === REPAIR_ATTACHMENT_STAGE.INITIAL) {
      attachmentsByStage.INITIAL.push(att);
    } else if (att.stage === REPAIR_ATTACHMENT_STAGE.COMPLETION) {
      attachmentsByStage.COMPLETION.push(att);
    } else if (att.stage === REPAIR_ATTACHMENT_STAGE.REOPEN_EVIDENCE) {
      attachmentsByStage.REOPEN_EVIDENCE.push(att);
    }
  }

  const reopenHistory = mapReopenHistory(reopenLogs);
  const latestRejectionReason =
    reopenHistory.length > 0 ? reopenHistory[reopenHistory.length - 1].reason : null;

  return {
    id: row.id,
    property: {
      id: row.property.id,
      name: row.property.name,
      address: row.property.address,
    },
    room: row.room
      ? {
          id: row.room.id,
          roomCode: row.room.roomCode,
        }
      : null,
    createdBy: mapUserSummary(row.createdBy),
    title: row.title,
    description: row.description,
    priority: row.priority as RepairTicketPriority,
    status: row.status as RepairTicketStatus,
    resolutionPlan: row.resolutionPlan ?? null,
    repairCost: toNullableNumber(row.repairCost),
    costBearer: (row.costBearer as RepairCostBearer | null) ?? null,
    scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    canEscalateToComplaint: computeCanEscalateToComplaint(row.status, row.createdAt, now),
    autoCloseAt: computeAutoCloseAt(row.status, row.completedAt),
    latestRejectionReason,
    reopenHistory,
    attachments,
    attachmentsByStage,
  };
}
