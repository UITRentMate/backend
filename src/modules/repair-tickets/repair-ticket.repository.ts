import type { Prisma } from '@prisma/client';
import { CONTRACT_STATUS, REPAIR_TICKET_STATUS } from '../../common/constants/phase3-status';
import { prisma } from '../../infrastructure/database/prisma';
import type {
  ActiveResidencyMatch,
  CreateTicketRepoInput,
  PrismaDbClient,
  ReopenAuditLogRow,
  RepairTicketDetailRow,
  RepairTicketListRow,
  RepairTicketMutationRow,
} from './repair-ticket.types';

const USER_SUMMARY_SELECT = {
  id: true,
  fullName: true,
  avatarUrl: true,
} satisfies Prisma.UserSelect;

const REPAIR_TICKET_DETAIL_SELECT = {
  id: true,
  propertyId: true,
  roomId: true,
  createdById: true,
  title: true,
  description: true,
  priority: true,
  status: true,
  resolutionPlan: true,
  repairCost: true,
  costBearer: true,
  scheduledAt: true,
  completedAt: true,
  closedAt: true,
  createdAt: true,
  property: {
    select: {
      id: true,
      name: true,
      address: true,
    },
  },
  room: {
    select: {
      id: true,
      roomCode: true,
    },
  },
  createdBy: {
    select: USER_SUMMARY_SELECT,
  },
  attachments: {
    orderBy: [{ id: 'asc' }],
    select: {
      id: true,
      fileUrl: true,
      stage: true,
      reason: true,
      uploadedBy: {
        select: USER_SUMMARY_SELECT,
      },
    },
  },
} satisfies Prisma.RepairTicketSelect;

export class RepairTicketRepository {
  public static async lockContractRow(
    tx: Prisma.TransactionClient,
    contractId: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM contracts WHERE id = ${contractId}::uuid FOR UPDATE
    `;
    return rows.length > 0;
  }

  public static async lockTicketRow(
    tx: Prisma.TransactionClient,
    ticketId: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM repair_tickets WHERE id = ${ticketId}::uuid FOR UPDATE
    `;
    return rows.length > 0;
  }

  public static async lockTicketRowSkipLocked(
    tx: Prisma.TransactionClient,
    ticketId: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM repair_tickets WHERE id = ${ticketId}::uuid FOR UPDATE SKIP LOCKED
    `;
    return rows.length > 0;
  }

  public static async findActiveResidencyForRoom(
    db: PrismaDbClient,
    roomId: string,
    userId: string,
  ): Promise<ActiveResidencyMatch | null> {
    const contract = await db.contract.findFirst({
      where: {
        roomId,
        status: CONTRACT_STATUS.ACTIVE,
        OR: [
          { tenantId: userId },
          {
            contractResidents: {
              some: {
                userId,
                leftAt: null,
              },
            },
          },
        ],
      },
      select: {
        id: true,
        roomId: true,
        room: {
          select: {
            propertyId: true,
            property: {
              select: {
                landlordId: true,
              },
            },
          },
        },
      },
    });

    if (!contract) {
      return null;
    }

    return {
      contractId: contract.id,
      roomId: contract.roomId,
      propertyId: contract.room.propertyId,
      landlordId: contract.room.property.landlordId,
    };
  }

  public static async findActiveResidencyForProperty(
    db: PrismaDbClient,
    propertyId: string,
    userId: string,
  ): Promise<ActiveResidencyMatch | null> {
    const contract = await db.contract.findFirst({
      where: {
        status: CONTRACT_STATUS.ACTIVE,
        room: {
          propertyId,
        },
        OR: [
          { tenantId: userId },
          {
            contractResidents: {
              some: {
                userId,
                leftAt: null,
              },
            },
          },
        ],
      },
      orderBy: [{ activatedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        roomId: true,
        room: {
          select: {
            propertyId: true,
            property: {
              select: {
                landlordId: true,
              },
            },
          },
        },
      },
    });

    if (!contract) {
      return null;
    }

    return {
      contractId: contract.id,
      roomId: contract.roomId,
      propertyId: contract.room.propertyId,
      landlordId: contract.room.property.landlordId,
    };
  }

  public static async findTenantActiveScope(
    userId: string,
  ): Promise<{ activeRoomIds: string[]; activePropertyIds: string[] }> {
    const contracts = await prisma.contract.findMany({
      where: {
        status: CONTRACT_STATUS.ACTIVE,
        OR: [
          { tenantId: userId },
          {
            contractResidents: {
              some: {
                userId,
                leftAt: null,
              },
            },
          },
        ],
      },
      select: {
        roomId: true,
        room: {
          select: {
            propertyId: true,
          },
        },
      },
    });

    const roomIds = new Set<string>();
    const propertyIds = new Set<string>();
    for (const contract of contracts) {
      roomIds.add(contract.roomId);
      propertyIds.add(contract.room.propertyId);
    }

    return {
      activeRoomIds: Array.from(roomIds),
      activePropertyIds: Array.from(propertyIds),
    };
  }

  public static async findActiveResidentUserIdsForRoom(
    db: PrismaDbClient,
    roomId: string,
  ): Promise<string[]> {
    const contract = await db.contract.findFirst({
      where: {
        roomId,
        status: CONTRACT_STATUS.ACTIVE,
      },
      select: {
        tenantId: true,
        contractResidents: {
          where: { leftAt: null },
          select: { userId: true },
        },
      },
    });

    if (!contract) {
      return [];
    }

    const recipients = new Set<string>([contract.tenantId]);
    for (const resident of contract.contractResidents) {
      recipients.add(resident.userId);
    }
    return Array.from(recipients);
  }

  public static async findTicketDetailById(
    db: PrismaDbClient,
    ticketId: string,
  ): Promise<RepairTicketDetailRow | null> {
    return db.repairTicket.findUnique({
      where: { id: ticketId },
      select: REPAIR_TICKET_DETAIL_SELECT,
    });
  }

  public static async findTicketForMutation(
    db: PrismaDbClient,
    ticketId: string,
  ): Promise<RepairTicketMutationRow | null> {
    return db.repairTicket.findUnique({
      where: { id: ticketId },
      select: {
        id: true,
        propertyId: true,
        roomId: true,
        createdById: true,
        title: true,
        status: true,
        resolutionPlan: true,
        repairCost: true,
        costBearer: true,
        scheduledAt: true,
        completedAt: true,
        closedAt: true,
        createdAt: true,
        property: {
          select: {
            id: true,
            landlordId: true,
          },
        },
      },
    });
  }

  public static async findTicketsPaginated(
    where: Prisma.RepairTicketWhereInput,
    page: number,
    limit: number,
  ): Promise<{ items: RepairTicketListRow[]; total: number }> {
    const [items, total] = await Promise.all([
      prisma.repairTicket.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          title: true,
          priority: true,
          status: true,
          scheduledAt: true,
          completedAt: true,
          closedAt: true,
          createdAt: true,
          property: {
            select: {
              id: true,
              name: true,
              address: true,
            },
          },
          room: {
            select: {
              id: true,
              roomCode: true,
            },
          },
          createdBy: {
            select: USER_SUMMARY_SELECT,
          },
          attachments: {
            orderBy: [{ id: 'asc' }],
            select: {
              id: true,
              fileUrl: true,
              stage: true,
            },
          },
          _count: {
            select: {
              attachments: true,
            },
          },
        },
      }),
      prisma.repairTicket.count({ where }),
    ]);

    return { items, total };
  }

  public static async findReopenAuditLogs(
    db: PrismaDbClient,
    ticketId: string,
  ): Promise<ReopenAuditLogRow[]> {
    return db.auditLog.findMany({
      where: {
        entityType: 'REPAIR_TICKET',
        entityId: ticketId,
        action: 'REPAIR_TICKET_REOPENED',
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        actorId: true,
        newData: true,
        createdAt: true,
      },
    });
  }

  public static async findStaleAwaitingConfirmationTicketIds(
    cutoff: Date,
    limit: number,
    extraWhere?: Prisma.RepairTicketWhereInput,
  ): Promise<string[]> {
    const staleCondition: Prisma.RepairTicketWhereInput = {
      status: REPAIR_TICKET_STATUS.AWAITING_CONFIRMATION,
      completedAt: { lte: cutoff },
    };

    const where: Prisma.RepairTicketWhereInput = extraWhere
      ? { AND: [extraWhere, staleCondition] }
      : staleCondition;

    const rows = await prisma.repairTicket.findMany({
      where,
      orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });

    return rows.map((row) => row.id);
  }

  public static async createTicketWithAttachments(
    tx: Prisma.TransactionClient,
    data: CreateTicketRepoInput,
  ): Promise<RepairTicketDetailRow> {
    return tx.repairTicket.create({
      data: {
        id: data.id,
        propertyId: data.propertyId,
        roomId: data.roomId,
        createdById: data.createdById,
        title: data.title,
        description: data.description,
        priority: data.priority,
        status: data.status,
        attachments: {
          create: data.attachments.map((att) => ({
            id: att.id,
            uploadedById: att.uploadedById,
            fileUrl: att.fileUrl,
            stage: att.stage,
            reason: att.reason ?? null,
          })),
        },
      },
      select: REPAIR_TICKET_DETAIL_SELECT,
    });
  }

  public static async updateTicket(
    tx: Prisma.TransactionClient,
    ticketId: string,
    data: Prisma.RepairTicketUpdateInput,
  ): Promise<void> {
    await tx.repairTicket.update({
      where: { id: ticketId },
      data,
    });
  }

  public static async createAttachments(
    tx: Prisma.TransactionClient,
    rows: Prisma.RepairAttachmentCreateManyInput[],
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await tx.repairAttachment.createMany({
      data: rows,
    });
  }
}
