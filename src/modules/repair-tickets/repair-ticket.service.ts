import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  NOTIFICATION_EVENT_TYPE,
  PHASE3_TIME_LIMITS_MS,
  REPAIR_ATTACHMENT_STAGE,
  REPAIR_TICKET_STATUS,
} from '../../common/constants/phase3-status';
import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser } from '../../common/middleware/require-role';
import { recordAuditLog } from '../../common/utils/audit-log.util';
import {
  createNotification,
  createNotificationsBatch,
  type CreateNotificationInput,
} from '../../common/utils/notification.util';
import { prisma } from '../../infrastructure/database/prisma';
import { mapRepairTicketDetail, mapRepairTicketListItem } from './repair-ticket.mapper';
import { RepairTicketRepository } from './repair-ticket.repository';
import type {
  AcceptRepairTicketInput,
  AutoCloseBatchResult,
  CompleteRepairTicketInput,
  CreateRepairTicketInput,
  DecimalLike,
  PaginatedRepairTicketsDTO,
  PrismaDbClient,
  RejectRepairCompletionInput,
  RepairTicketDetailDTO,
  RepairTicketListQuery,
  RepairTicketMutationRow,
  UploadedRepairAttachment,
} from './repair-ticket.types';
import {
  cleanupUploadedRepairFiles,
  uploadRepairFilesToCloudinary,
} from './repair-ticket.upload';

const ROOM_NOT_FOUND_MESSAGE =
  'Phòng trọ không tồn tại hoặc bạn không có hợp đồng đang hiệu lực tại phòng này';
const PROPERTY_NOT_FOUND_MESSAGE =
  'Khu trọ không tồn tại hoặc bạn không có hợp đồng đang hiệu lực tại khu trọ này';
const TICKET_NOT_FOUND_MESSAGE = 'Phiếu sự cố không tồn tại hoặc bạn không có quyền truy cập';
const TICKET_ALREADY_CLOSED_MESSAGE = 'Phiếu sự cố đã được đóng trước đó';
const TICKET_INVALID_STATUS_MESSAGE =
  'Trạng thái hiện tại của phiếu sự cố không cho phép thực hiện thao tác này';
const TICKET_AUTO_CLOSED_MESSAGE =
  'Phiếu sự cố đã tự động đóng sau 5 ngày kể từ khi hoàn tất sửa chữa';

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

export function formatNotificationTitle(title: string, maxLength = 160): string {
  const trimmed = title.trim();
  const codePoints = [...trimmed];
  if (codePoints.length <= maxLength) {
    return trimmed;
  }
  return `${codePoints.slice(0, maxLength - 3).join('').trimEnd()}...`;
}

function isTicketAutoCloseExpired(
  ticket: Pick<RepairTicketMutationRow, 'status' | 'completedAt'>,
  now: Date,
): boolean {
  return (
    ticket.status === REPAIR_TICKET_STATUS.AWAITING_CONFIRMATION &&
    ticket.completedAt !== null &&
    now.getTime() - ticket.completedAt.getTime() >= PHASE3_TIME_LIMITS_MS.REPAIR_AUTO_CLOSE_WAIT_MS
  );
}

async function resolveTenantNotificationRecipients(
  db: PrismaDbClient,
  ticket: Pick<RepairTicketMutationRow, 'roomId' | 'propertyId' | 'createdById'>,
): Promise<string[]> {
  if (ticket.roomId !== null) {
    return RepairTicketRepository.findActiveResidentUserIdsForRoom(db, ticket.roomId);
  }
  const creatorStillActive = await RepairTicketRepository.findActiveResidencyForProperty(
    db,
    ticket.propertyId,
    ticket.createdById,
  );
  return creatorStillActive ? [ticket.createdById] : [];
}

async function assertTenantCanReadTicket(
  db: PrismaDbClient,
  ticket: Pick<RepairTicketMutationRow, 'roomId' | 'propertyId'>,
  userId: string,
): Promise<void> {
  if (ticket.roomId !== null) {
    const match = await RepairTicketRepository.findActiveResidencyForRoom(db, ticket.roomId, userId);
    if (!match) {
      throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
    }
    return;
  }

  const match = await RepairTicketRepository.findActiveResidencyForProperty(
    db,
    ticket.propertyId,
    userId,
  );
  if (!match) {
    throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
  }
}

async function assertTenantCanAcceptOrReject(
  db: PrismaDbClient,
  ticket: Pick<RepairTicketMutationRow, 'roomId' | 'propertyId' | 'createdById'>,
  userId: string,
): Promise<void> {
  if (ticket.roomId !== null) {
    const match = await RepairTicketRepository.findActiveResidencyForRoom(db, ticket.roomId, userId);
    if (!match) {
      throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
    }
    return;
  }

  if (ticket.createdById !== userId) {
    throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
  }

  const match = await RepairTicketRepository.findActiveResidencyForProperty(
    db,
    ticket.propertyId,
    userId,
  );
  if (!match) {
    throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
  }
}

async function commitAutoCloseInTx(
  tx: Prisma.TransactionClient,
  ticket: RepairTicketMutationRow,
  now: Date,
): Promise<void> {
  await RepairTicketRepository.updateTicket(tx, ticket.id, {
    status: REPAIR_TICKET_STATUS.CLOSED,
    closedAt: now,
  });

  const tenantRecipientIds = await resolveTenantNotificationRecipients(tx, ticket);
  const title = formatNotificationTitle(`Sự cố đã tự động đóng sau 5 ngày: ${ticket.title}`);
  const notificationsByRecipient = new Map<string, CreateNotificationInput>();

  notificationsByRecipient.set(ticket.property.landlordId, {
    recipientId: ticket.property.landlordId,
    title,
    eventType: NOTIFICATION_EVENT_TYPE.REPAIR_TICKET_CLOSED,
    payload: {
      content: `Phiếu sự cố "${ticket.title}" đã tự động đóng sau 5 ngày kể từ khi báo hoàn tất sửa chữa.`,
      actionUrl: `/landlord/repair-tickets/${ticket.id}`,
      relatedEntityType: 'REPAIR_TICKET',
      relatedEntityId: ticket.id,
      metadata: {
        ticketId: ticket.id,
        propertyId: ticket.propertyId,
        roomId: ticket.roomId,
        autoClosed: true,
      },
    },
  });

  for (const tenantId of tenantRecipientIds) {
    if (!notificationsByRecipient.has(tenantId)) {
      notificationsByRecipient.set(tenantId, {
        recipientId: tenantId,
        title,
        eventType: NOTIFICATION_EVENT_TYPE.REPAIR_TICKET_CLOSED,
        payload: {
          content: `Phiếu sự cố "${ticket.title}" đã tự động đóng sau 5 ngày không có phản hồi nghiệm thu.`,
          actionUrl: `/repair-tickets/${ticket.id}`,
          relatedEntityType: 'REPAIR_TICKET',
          relatedEntityId: ticket.id,
          metadata: {
            ticketId: ticket.id,
            propertyId: ticket.propertyId,
            roomId: ticket.roomId,
            autoClosed: true,
          },
        },
      });
    }
  }

  await createNotificationsBatch(tx, Array.from(notificationsByRecipient.values()));

  await recordAuditLog(tx, {
    actorId: null,
    entityType: 'REPAIR_TICKET',
    entityId: ticket.id,
    action: 'REPAIR_TICKET_AUTO_CLOSED',
    oldData: {
      status: REPAIR_TICKET_STATUS.AWAITING_CONFIRMATION,
      completedAt: ticket.completedAt ? ticket.completedAt.toISOString() : null,
      closedAt: null,
    },
    newData: {
      status: REPAIR_TICKET_STATUS.CLOSED,
      closedAt: now.toISOString(),
      autoClosed: true,
    },
  });
}

function assertStatusForTransition(
  currentStatus: string,
  expectedStatus: string,
): void {
  if (currentStatus === REPAIR_TICKET_STATUS.CLOSED) {
    throw new ApiError(409, 'REPAIR_TICKET_ALREADY_CLOSED', TICKET_ALREADY_CLOSED_MESSAGE);
  }
  if (currentStatus !== expectedStatus) {
    throw new ApiError(409, 'REPAIR_TICKET_INVALID_STATUS', TICKET_INVALID_STATUS_MESSAGE);
  }
}

export class RepairTicketService {
  public static async createRepairTicket(
    input: CreateRepairTicketInput,
    files: readonly Express.Multer.File[],
    currentUser: CurrentUser,
  ): Promise<RepairTicketDetailDTO> {
    const preCheck = input.roomId
      ? await RepairTicketRepository.findActiveResidencyForRoom(
          prisma,
          input.roomId,
          currentUser.id,
        )
      : await RepairTicketRepository.findActiveResidencyForProperty(
          prisma,
          input.propertyId!,
          currentUser.id,
        );

    if (input.roomId) {
      if (!preCheck || (input.propertyId && input.propertyId !== preCheck.propertyId)) {
        throw new ApiError(404, 'ROOM_NOT_FOUND', ROOM_NOT_FOUND_MESSAGE);
      }
    } else if (!preCheck) {
      throw new ApiError(404, 'PROPERTY_NOT_FOUND', PROPERTY_NOT_FOUND_MESSAGE);
    }

    const ticketId = randomUUID();
    const uploaded = await uploadRepairFilesToCloudinary(files, {
      propertyId: preCheck.propertyId,
      ticketId,
      stage: REPAIR_ATTACHMENT_STAGE.INITIAL,
    });

    try {
      const now = new Date();
      const created = await prisma.$transaction(async (tx) => {
        const locked = await RepairTicketRepository.lockContractRow(tx, preCheck.contractId);
        if (!locked) {
          throw input.roomId
            ? new ApiError(404, 'ROOM_NOT_FOUND', ROOM_NOT_FOUND_MESSAGE)
            : new ApiError(404, 'PROPERTY_NOT_FOUND', PROPERTY_NOT_FOUND_MESSAGE);
        }

        const confirmed = input.roomId
          ? await RepairTicketRepository.findActiveResidencyForRoom(
              tx,
              input.roomId,
              currentUser.id,
            )
          : await RepairTicketRepository.findActiveResidencyForProperty(
              tx,
              input.propertyId!,
              currentUser.id,
            );

        if (input.roomId) {
          if (!confirmed || confirmed.propertyId !== preCheck.propertyId) {
            throw new ApiError(404, 'ROOM_NOT_FOUND', ROOM_NOT_FOUND_MESSAGE);
          }
        } else if (!confirmed) {
          throw new ApiError(404, 'PROPERTY_NOT_FOUND', PROPERTY_NOT_FOUND_MESSAGE);
        }

        const ticket = await RepairTicketRepository.createTicketWithAttachments(tx, {
          id: ticketId,
          propertyId: confirmed.propertyId,
          roomId: input.roomId ?? null,
          createdById: currentUser.id,
          title: input.title,
          description: input.description,
          priority: input.priority,
          status: REPAIR_TICKET_STATUS.OPEN,
          attachments: uploaded.map((item) => ({
            id: item.id,
            uploadedById: currentUser.id,
            fileUrl: item.fileUrl,
            stage: REPAIR_ATTACHMENT_STAGE.INITIAL,
            reason: null,
          })),
        });

        await createNotification(tx, {
          recipientId: confirmed.landlordId,
          title: formatNotificationTitle(`Báo cáo sự cố mới: ${ticket.title}`),
          eventType: NOTIFICATION_EVENT_TYPE.REPAIR_TICKET_CREATED,
          payload: {
            content: `${currentUser.fullName} đã gửi báo cáo sự cố "${ticket.title}".`,
            actionUrl: `/landlord/repair-tickets/${ticket.id}`,
            relatedEntityType: 'REPAIR_TICKET',
            relatedEntityId: ticket.id,
            metadata: {
              ticketId: ticket.id,
              propertyId: ticket.propertyId,
              roomId: ticket.roomId,
              priority: ticket.priority,
            },
          },
        });

        await recordAuditLog(tx, {
          actorId: currentUser.id,
          entityType: 'REPAIR_TICKET',
          entityId: ticket.id,
          action: 'REPAIR_TICKET_CREATED',
          oldData: null,
          newData: {
            propertyId: ticket.propertyId,
            roomId: ticket.roomId,
            priority: ticket.priority,
            status: REPAIR_TICKET_STATUS.OPEN,
            attachmentCount: uploaded.length,
          },
        });

        return ticket;
      });

      return mapRepairTicketDetail(created, [], now);
    } catch (error) {
      await cleanupUploadedRepairFiles(uploaded.map((item) => item.publicId));
      throw error;
    }
  }

  public static async listRepairTickets(
    query: RepairTicketListQuery,
    currentUser: CurrentUser,
  ): Promise<PaginatedRepairTicketsDTO> {
    const now = new Date();
    let scopeWhere: Prisma.RepairTicketWhereInput;

    if (currentUser.role === 'LANDLORD') {
      scopeWhere = { property: { landlordId: currentUser.id } };
    } else {
      const { activeRoomIds, activePropertyIds } =
        await RepairTicketRepository.findTenantActiveScope(currentUser.id);

      if (activeRoomIds.length === 0 && activePropertyIds.length === 0) {
        return {
          items: [],
          total: 0,
          page: query.page,
          limit: query.limit,
          totalPages: 0,
        };
      }

      const orClauses: Prisma.RepairTicketWhereInput[] = [];
      if (activeRoomIds.length > 0) {
        orClauses.push({ roomId: { in: activeRoomIds } });
      }
      if (activePropertyIds.length > 0) {
        orClauses.push({ roomId: null, propertyId: { in: activePropertyIds } });
      }
      scopeWhere = orClauses.length === 1 ? orClauses[0] : { OR: orClauses };
    }

    const lazyCloseClauses: Prisma.RepairTicketWhereInput[] = [scopeWhere];
    if (query.propertyId) {
      lazyCloseClauses.push({ propertyId: query.propertyId });
    }
    if (query.roomId) {
      lazyCloseClauses.push({ roomId: query.roomId });
    }
    const lazyCloseWhere: Prisma.RepairTicketWhereInput =
      lazyCloseClauses.length === 1 ? lazyCloseClauses[0] : { AND: lazyCloseClauses };

    await RepairTicketService.autoCloseStaleRepairTickets({
      now,
      batchSize: 50,
      extraWhere: lazyCloseWhere,
    });

    const filterClauses: Prisma.RepairTicketWhereInput[] = [scopeWhere];
    if (query.status) {
      filterClauses.push({ status: query.status });
    }
    if (query.priority) {
      filterClauses.push({ priority: query.priority });
    }
    if (query.propertyId) {
      filterClauses.push({ propertyId: query.propertyId });
    }
    if (query.roomId) {
      filterClauses.push({ roomId: query.roomId });
    }

    const where: Prisma.RepairTicketWhereInput =
      filterClauses.length === 1 ? filterClauses[0] : { AND: filterClauses };

    const { items, total } = await RepairTicketRepository.findTicketsPaginated(
      where,
      query.page,
      query.limit,
    );

    return {
      items: items.map((item) => mapRepairTicketListItem(item, now)),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit) || 0,
    };
  }

  public static async getRepairTicketDetail(
    ticketId: string,
    currentUser: CurrentUser,
  ): Promise<RepairTicketDetailDTO> {
    const ticket = await RepairTicketRepository.findTicketForMutation(prisma, ticketId);
    if (!ticket) {
      throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
    }

    if (currentUser.role === 'LANDLORD') {
      if (ticket.property.landlordId !== currentUser.id) {
        throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
      }
    } else {
      await assertTenantCanReadTicket(prisma, ticket, currentUser.id);
    }

    const now = new Date();
    if (isTicketAutoCloseExpired(ticket, now)) {
      await RepairTicketService.autoCloseSingleTicketIfStale(ticketId, now);
    }

    const [detail, reopenLogs] = await Promise.all([
      RepairTicketRepository.findTicketDetailById(prisma, ticketId),
      RepairTicketRepository.findReopenAuditLogs(prisma, ticketId),
    ]);

    if (!detail) {
      throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
    }

    return mapRepairTicketDetail(detail, reopenLogs, now);
  }

  public static async acceptRepairTicket(
    ticketId: string,
    input: AcceptRepairTicketInput,
    currentUser: CurrentUser,
  ): Promise<RepairTicketDetailDTO> {
    const now = new Date();

    return prisma.$transaction(async (tx) => {
      const locked = await RepairTicketRepository.lockTicketRow(tx, ticketId);
      if (!locked) {
        throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
      }

      const ticket = await RepairTicketRepository.findTicketForMutation(tx, ticketId);
      if (!ticket || ticket.property.landlordId !== currentUser.id) {
        throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
      }

      assertStatusForTransition(ticket.status, REPAIR_TICKET_STATUS.OPEN);

      await RepairTicketRepository.updateTicket(tx, ticket.id, {
        status: REPAIR_TICKET_STATUS.IN_PROGRESS,
        resolutionPlan: input.resolutionPlan,
        scheduledAt: input.scheduledAt,
      });

      const recipientIds = await resolveTenantNotificationRecipients(tx, ticket);
      const title = formatNotificationTitle(`Sự cố đã được tiếp nhận: ${ticket.title}`);
      await createNotificationsBatch(
        tx,
        recipientIds.map((recipientId) => ({
          recipientId,
          title,
          eventType: NOTIFICATION_EVENT_TYPE.REPAIR_TICKET_ACCEPTED,
          payload: {
            content: `Chủ trọ đã tiếp nhận sự cố "${ticket.title}" với phương án: ${input.resolutionPlan}`,
            actionUrl: `/repair-tickets/${ticket.id}`,
            relatedEntityType: 'REPAIR_TICKET',
            relatedEntityId: ticket.id,
            metadata: {
              ticketId: ticket.id,
              propertyId: ticket.propertyId,
              roomId: ticket.roomId,
              scheduledAt: input.scheduledAt.toISOString(),
            },
          },
        })),
      );

      await recordAuditLog(tx, {
        actorId: currentUser.id,
        entityType: 'REPAIR_TICKET',
        entityId: ticket.id,
        action: 'REPAIR_TICKET_ACCEPTED',
        oldData: {
          status: REPAIR_TICKET_STATUS.OPEN,
          resolutionPlan: ticket.resolutionPlan,
          scheduledAt: ticket.scheduledAt ? ticket.scheduledAt.toISOString() : null,
        },
        newData: {
          status: REPAIR_TICKET_STATUS.IN_PROGRESS,
          resolutionPlan: input.resolutionPlan,
          scheduledAt: input.scheduledAt.toISOString(),
        },
      });

      const [detail, reopenLogs] = await Promise.all([
        RepairTicketRepository.findTicketDetailById(tx, ticket.id),
        RepairTicketRepository.findReopenAuditLogs(tx, ticket.id),
      ]);
      if (!detail) {
        throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
      }

      return mapRepairTicketDetail(detail, reopenLogs, now);
    });
  }

  public static async completeRepairTicket(
    ticketId: string,
    input: CompleteRepairTicketInput,
    files: readonly Express.Multer.File[],
    currentUser: CurrentUser,
  ): Promise<RepairTicketDetailDTO> {
    const preCheck = await RepairTicketRepository.findTicketForMutation(prisma, ticketId);
    if (!preCheck || preCheck.property.landlordId !== currentUser.id) {
      throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
    }

    assertStatusForTransition(preCheck.status, REPAIR_TICKET_STATUS.IN_PROGRESS);

    const uploaded: UploadedRepairAttachment[] = await uploadRepairFilesToCloudinary(files, {
      propertyId: preCheck.propertyId,
      ticketId,
      stage: REPAIR_ATTACHMENT_STAGE.COMPLETION,
    });

    try {
      const now = new Date();
      return await prisma.$transaction(async (tx) => {
        const locked = await RepairTicketRepository.lockTicketRow(tx, ticketId);
        if (!locked) {
          throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
        }

        const ticket = await RepairTicketRepository.findTicketForMutation(tx, ticketId);
        if (!ticket || ticket.property.landlordId !== currentUser.id) {
          throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
        }

        assertStatusForTransition(ticket.status, REPAIR_TICKET_STATUS.IN_PROGRESS);

        await RepairTicketRepository.updateTicket(tx, ticket.id, {
          status: REPAIR_TICKET_STATUS.AWAITING_CONFIRMATION,
          completedAt: now,
          repairCost: input.repairCost ?? null,
          costBearer: input.costBearer ?? null,
        });

        await RepairTicketRepository.createAttachments(
          tx,
          uploaded.map((item) => ({
            id: item.id,
            ticketId: ticket.id,
            uploadedById: currentUser.id,
            fileUrl: item.fileUrl,
            stage: REPAIR_ATTACHMENT_STAGE.COMPLETION,
            reason: null,
          })),
        );

        const recipientIds = await resolveTenantNotificationRecipients(tx, ticket);
        const title = formatNotificationTitle(
          'Sự cố đã sửa xong, vui lòng nghiệm thu trong 5 ngày',
        );
        await createNotificationsBatch(
          tx,
          recipientIds.map((recipientId) => ({
            recipientId,
            title,
            eventType: NOTIFICATION_EVENT_TYPE.REPAIR_TICKET_COMPLETED,
            payload: {
              content: `Chủ trọ đã hoàn tất sửa chữa sự cố "${ticket.title}". Vui lòng nghiệm thu trong vòng 5 ngày.`,
              actionUrl: `/repair-tickets/${ticket.id}`,
              relatedEntityType: 'REPAIR_TICKET',
              relatedEntityId: ticket.id,
              metadata: {
                ticketId: ticket.id,
                propertyId: ticket.propertyId,
                roomId: ticket.roomId,
                completedAt: now.toISOString(),
                repairCost: input.repairCost ?? null,
                costBearer: input.costBearer ?? null,
              },
            },
          })),
        );

        await recordAuditLog(tx, {
          actorId: currentUser.id,
          entityType: 'REPAIR_TICKET',
          entityId: ticket.id,
          action: 'REPAIR_TICKET_COMPLETED',
          oldData: {
            status: REPAIR_TICKET_STATUS.IN_PROGRESS,
            completedAt: null,
            repairCost: toNullableNumber(ticket.repairCost),
            costBearer: ticket.costBearer ?? null,
          },
          newData: {
            status: REPAIR_TICKET_STATUS.AWAITING_CONFIRMATION,
            completedAt: now.toISOString(),
            repairCost: input.repairCost ?? null,
            costBearer: input.costBearer ?? null,
            attachmentCount: uploaded.length,
          },
        });

        const [detail, reopenLogs] = await Promise.all([
          RepairTicketRepository.findTicketDetailById(tx, ticket.id),
          RepairTicketRepository.findReopenAuditLogs(tx, ticket.id),
        ]);
        if (!detail) {
          throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
        }

        return mapRepairTicketDetail(detail, reopenLogs, now);
      });
    } catch (error) {
      await cleanupUploadedRepairFiles(uploaded.map((item) => item.publicId));
      throw error;
    }
  }

  public static async confirmCompletion(
    ticketId: string,
    currentUser: CurrentUser,
  ): Promise<RepairTicketDetailDTO> {
    const now = new Date();

    const outcome = await prisma.$transaction(async (tx) => {
      const locked = await RepairTicketRepository.lockTicketRow(tx, ticketId);
      if (!locked) {
        throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
      }

      const ticket = await RepairTicketRepository.findTicketForMutation(tx, ticketId);
      if (!ticket) {
        throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
      }

      await assertTenantCanAcceptOrReject(tx, ticket, currentUser.id);
      assertStatusForTransition(ticket.status, REPAIR_TICKET_STATUS.AWAITING_CONFIRMATION);

      if (isTicketAutoCloseExpired(ticket, now)) {
        await commitAutoCloseInTx(tx, ticket, now);
        return { outcome: 'AUTO_CLOSED' as const };
      }

      await RepairTicketRepository.updateTicket(tx, ticket.id, {
        status: REPAIR_TICKET_STATUS.CLOSED,
        closedAt: now,
      });

      const title = formatNotificationTitle(`Sự cố đã được nghiệm thu và đóng: ${ticket.title}`);
      const notificationsByRecipient = new Map<string, CreateNotificationInput>();

      notificationsByRecipient.set(ticket.property.landlordId, {
        recipientId: ticket.property.landlordId,
        title,
        eventType: NOTIFICATION_EVENT_TYPE.REPAIR_TICKET_CLOSED,
        payload: {
          content: `${currentUser.fullName} đã nghiệm thu đạt và đóng sự cố "${ticket.title}".`,
          actionUrl: `/landlord/repair-tickets/${ticket.id}`,
          relatedEntityType: 'REPAIR_TICKET',
          relatedEntityId: ticket.id,
          metadata: {
            ticketId: ticket.id,
            propertyId: ticket.propertyId,
            roomId: ticket.roomId,
            autoClosed: false,
            confirmedById: currentUser.id,
          },
        },
      });

      if (ticket.roomId !== null) {
        const roomResidentIds = await RepairTicketRepository.findActiveResidentUserIdsForRoom(
          tx,
          ticket.roomId,
        );
        for (const residentId of roomResidentIds) {
          if (residentId === currentUser.id || notificationsByRecipient.has(residentId)) {
            continue;
          }
          notificationsByRecipient.set(residentId, {
            recipientId: residentId,
            title,
            eventType: NOTIFICATION_EVENT_TYPE.REPAIR_TICKET_CLOSED,
            payload: {
              content: `${currentUser.fullName} đã nghiệm thu đạt và đóng sự cố "${ticket.title}".`,
              actionUrl: `/repair-tickets/${ticket.id}`,
              relatedEntityType: 'REPAIR_TICKET',
              relatedEntityId: ticket.id,
              metadata: {
                ticketId: ticket.id,
                propertyId: ticket.propertyId,
                roomId: ticket.roomId,
                autoClosed: false,
                confirmedById: currentUser.id,
              },
            },
          });
        }
      }

      await createNotificationsBatch(tx, Array.from(notificationsByRecipient.values()));

      await recordAuditLog(tx, {
        actorId: currentUser.id,
        entityType: 'REPAIR_TICKET',
        entityId: ticket.id,
        action: 'REPAIR_TICKET_CONFIRMED',
        oldData: {
          status: REPAIR_TICKET_STATUS.AWAITING_CONFIRMATION,
          closedAt: null,
        },
        newData: {
          status: REPAIR_TICKET_STATUS.CLOSED,
          closedAt: now.toISOString(),
        },
      });

      const [detail, reopenLogs] = await Promise.all([
        RepairTicketRepository.findTicketDetailById(tx, ticket.id),
        RepairTicketRepository.findReopenAuditLogs(tx, ticket.id),
      ]);
      if (!detail) {
        throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
      }

      return {
        outcome: 'CONFIRMED' as const,
        dto: mapRepairTicketDetail(detail, reopenLogs, now),
      };
    });

    if (outcome.outcome === 'AUTO_CLOSED') {
      throw new ApiError(409, 'REPAIR_TICKET_AUTO_CLOSED', TICKET_AUTO_CLOSED_MESSAGE);
    }

    return outcome.dto;
  }

  public static async rejectCompletion(
    ticketId: string,
    input: RejectRepairCompletionInput,
    files: readonly Express.Multer.File[],
    currentUser: CurrentUser,
  ): Promise<RepairTicketDetailDTO> {
    const preCheck = await RepairTicketRepository.findTicketForMutation(prisma, ticketId);
    if (!preCheck) {
      throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
    }

    await assertTenantCanAcceptOrReject(prisma, preCheck, currentUser.id);
    assertStatusForTransition(preCheck.status, REPAIR_TICKET_STATUS.AWAITING_CONFIRMATION);

    const preCheckNow = new Date();
    if (isTicketAutoCloseExpired(preCheck, preCheckNow)) {
      await RepairTicketService.autoCloseSingleTicketIfStale(preCheck.id, preCheckNow);
      throw new ApiError(409, 'REPAIR_TICKET_AUTO_CLOSED', TICKET_AUTO_CLOSED_MESSAGE);
    }

    const uploaded =
      files.length > 0
        ? await uploadRepairFilesToCloudinary(files, {
            propertyId: preCheck.propertyId,
            ticketId,
            stage: REPAIR_ATTACHMENT_STAGE.REOPEN_EVIDENCE,
          })
        : [];

    try {
      const now = new Date();
      const outcome = await prisma.$transaction(async (tx) => {
        const locked = await RepairTicketRepository.lockTicketRow(tx, ticketId);
        if (!locked) {
          throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
        }

        const ticket = await RepairTicketRepository.findTicketForMutation(tx, ticketId);
        if (!ticket) {
          throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
        }

        await assertTenantCanAcceptOrReject(tx, ticket, currentUser.id);
        assertStatusForTransition(ticket.status, REPAIR_TICKET_STATUS.AWAITING_CONFIRMATION);

        if (isTicketAutoCloseExpired(ticket, now)) {
          await commitAutoCloseInTx(tx, ticket, now);
          return { outcome: 'AUTO_CLOSED' as const };
        }

        await RepairTicketRepository.updateTicket(tx, ticket.id, {
          status: REPAIR_TICKET_STATUS.IN_PROGRESS,
          completedAt: null,
          repairCost: null,
          costBearer: null,
        });

        if (uploaded.length > 0) {
          await RepairTicketRepository.createAttachments(
            tx,
            uploaded.map((item) => ({
              id: item.id,
              ticketId: ticket.id,
              uploadedById: currentUser.id,
              fileUrl: item.fileUrl,
              stage: REPAIR_ATTACHMENT_STAGE.REOPEN_EVIDENCE,
              reason: input.reason,
            })),
          );
        }

        await createNotification(tx, {
          recipientId: ticket.property.landlordId,
          title: formatNotificationTitle(`Yêu cầu khắc phục lại sự cố: ${ticket.title}`),
          eventType: NOTIFICATION_EVENT_TYPE.REPAIR_TICKET_REOPENED,
          payload: {
            content: `${currentUser.fullName} đánh giá chưa đạt cho sự cố "${ticket.title}". Lý do: ${input.reason}`,
            actionUrl: `/landlord/repair-tickets/${ticket.id}`,
            relatedEntityType: 'REPAIR_TICKET',
            relatedEntityId: ticket.id,
            metadata: {
              ticketId: ticket.id,
              propertyId: ticket.propertyId,
              roomId: ticket.roomId,
              reason: input.reason,
              attachmentCount: uploaded.length,
            },
          },
        });

        await recordAuditLog(tx, {
          actorId: currentUser.id,
          entityType: 'REPAIR_TICKET',
          entityId: ticket.id,
          action: 'REPAIR_TICKET_REOPENED',
          oldData: {
            status: REPAIR_TICKET_STATUS.AWAITING_CONFIRMATION,
            completedAt: ticket.completedAt ? ticket.completedAt.toISOString() : null,
            repairCost: toNullableNumber(ticket.repairCost),
            costBearer: ticket.costBearer ?? null,
          },
          newData: {
            status: REPAIR_TICKET_STATUS.IN_PROGRESS,
            completedAt: null,
            repairCost: null,
            costBearer: null,
            reason: input.reason,
            attachmentCount: uploaded.length,
          },
        });

        const [detail, reopenLogs] = await Promise.all([
          RepairTicketRepository.findTicketDetailById(tx, ticket.id),
          RepairTicketRepository.findReopenAuditLogs(tx, ticket.id),
        ]);
        if (!detail) {
          throw new ApiError(404, 'REPAIR_TICKET_NOT_FOUND', TICKET_NOT_FOUND_MESSAGE);
        }

        return {
          outcome: 'REOPENED' as const,
          dto: mapRepairTicketDetail(detail, reopenLogs, now),
        };
      });

      if (outcome.outcome === 'AUTO_CLOSED') {
        throw new ApiError(409, 'REPAIR_TICKET_AUTO_CLOSED', TICKET_AUTO_CLOSED_MESSAGE);
      }

      return outcome.dto;
    } catch (error) {
      await cleanupUploadedRepairFiles(uploaded.map((item) => item.publicId));
      throw error;
    }
  }

  public static async autoCloseSingleTicketIfStale(
    ticketId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const locked = await RepairTicketRepository.lockTicketRow(tx, ticketId);
      if (!locked) {
        return false;
      }

      const ticket = await RepairTicketRepository.findTicketForMutation(tx, ticketId);
      if (!ticket || !isTicketAutoCloseExpired(ticket, now)) {
        return false;
      }

      await commitAutoCloseInTx(tx, ticket, now);
      return true;
    });
  }

  public static async autoCloseStaleRepairTickets(options?: {
    now?: Date;
    batchSize?: number;
    extraWhere?: Prisma.RepairTicketWhereInput;
  }): Promise<AutoCloseBatchResult> {
    const now = options?.now ?? new Date();
    const batchSize = options?.batchSize ?? 100;
    const cutoff = new Date(now.getTime() - PHASE3_TIME_LIMITS_MS.REPAIR_AUTO_CLOSE_WAIT_MS);

    const ticketIds = await RepairTicketRepository.findStaleAwaitingConfirmationTicketIds(
      cutoff,
      batchSize,
      options?.extraWhere,
    );

    let closedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const ticketId of ticketIds) {
      try {
        const result = await prisma.$transaction(async (tx) => {
          const locked = await RepairTicketRepository.lockTicketRowSkipLocked(tx, ticketId);
          if (!locked) {
            return 'SKIPPED' as const;
          }

          const ticket = await RepairTicketRepository.findTicketForMutation(tx, ticketId);
          if (!ticket || !isTicketAutoCloseExpired(ticket, now)) {
            return 'SKIPPED' as const;
          }

          await commitAutoCloseInTx(tx, ticket, now);
          return 'CLOSED' as const;
        });

        if (result === 'CLOSED') {
          closedCount += 1;
        } else {
          skippedCount += 1;
        }
      } catch (error) {
        console.error('[RepairTicketAutoClose] Lỗi tự động đóng phiếu sự cố:', {
          ticketId,
          error,
        });
        failedCount += 1;
      }
    }

    return {
      scanned: ticketIds.length,
      closedCount,
      skippedCount,
      failedCount,
    };
  }
}

export async function autoCloseStaleRepairTickets(options?: {
  now?: Date;
  batchSize?: number;
  extraWhere?: Prisma.RepairTicketWhereInput;
}): Promise<AutoCloseBatchResult> {
  return RepairTicketService.autoCloseStaleRepairTickets(options);
}
