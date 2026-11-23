import type { Prisma } from '@prisma/client';
import {
  RESIDENT_INVITATION_STATUS,
  type ResidentInvitationStatus,
} from '../../common/constants/phase3-status';
import { prisma } from '../../infrastructure/database/prisma';
import type {
  ContractAccessContext,
  ContractMutationRow,
  ContractResidentRow,
  ContractResidentsRow,
  CreatedInvitationRow,
  InvitationAccessContext,
  InviteTargetUserRow,
  LockedInvitationRow,
  ParsedInviteIdentifier,
  ReceivedInvitationRow,
  ResidentInvitationListQuery,
} from './resident.types';

const USER_SUMMARY_SELECT = {
  id: true,
  fullName: true,
  avatarUrl: true,
} as const;

const CONTRACT_MUTATION_SELECT = {
  id: true,
  status: true,
  tenantId: true,
  room: {
    select: {
      id: true,
      roomCode: true,
      maxOccupants: true,
      property: {
        select: {
          id: true,
          landlordId: true,
        },
      },
    },
  },
} as const;

const INVITATION_MUTATION_SELECT = {
  id: true,
  contractId: true,
  invitedUserId: true,
  invitedById: true,
  status: true,
  expiresAt: true,
  invitedUser: {
    select: USER_SUMMARY_SELECT,
  },
  contract: {
    select: CONTRACT_MUTATION_SELECT,
  },
} as const;

export class ResidentRepository {
  /**
   * Khóa hàng hợp đồng theo một thứ tự duy nhất (contracts FOR UPDATE)
   * để tuần tự hóa toàn bộ thao tác ghi cư trú và triệt tiêu deadlock/race condition.
   */
  public static async lockContractRow(
    tx: Prisma.TransactionClient,
    contractId: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM contracts WHERE id = ${contractId}::uuid FOR UPDATE
    `;
    return rows.length > 0;
  }

  public static async findContractAccessContext(
    contractId: string,
    userId: string,
  ): Promise<ContractAccessContext | null> {
    const contract = await prisma.contract.findUnique({
      where: { id: contractId },
      select: {
        id: true,
        status: true,
        tenantId: true,
        room: {
          select: {
            property: {
              select: {
                landlordId: true,
              },
            },
          },
        },
        contractResidents: {
          where: {
            userId,
            leftAt: null,
          },
          select: {
            userId: true,
          },
          take: 1,
        },
      },
    });

    if (!contract) {
      return null;
    }

    const isPrimaryTenant = contract.tenantId === userId;
    const isLandlord = contract.room.property.landlordId === userId;
    const isActiveCoResident = contract.contractResidents.length > 0;

    if (!isPrimaryTenant && !isLandlord && !isActiveCoResident) {
      return null;
    }

    return {
      contractId: contract.id,
      status: contract.status,
      tenantId: contract.tenantId,
      landlordId: contract.room.property.landlordId,
      isPrimaryTenant,
      isLandlord,
      isActiveCoResident,
    };
  }

  public static async expireContractPendingInvitations(
    contractId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const result = await prisma.residentInvitation.updateMany({
      where: {
        contractId,
        status: RESIDENT_INVITATION_STATUS.PENDING,
        expiresAt: { lte: now },
      },
      data: {
        status: RESIDENT_INVITATION_STATUS.EXPIRED,
      },
    });

    return result.count;
  }

  public static async findContractResidentsDetail(
    contractId: string,
    includePendingInvitations: boolean,
    now: Date = new Date(),
  ): Promise<ContractResidentsRow | null> {
    const baseSelect = {
      id: true,
      status: true,
      activatedAt: true,
      tenant: {
        select: USER_SUMMARY_SELECT,
      },
      room: {
        select: {
          id: true,
          roomCode: true,
          maxOccupants: true,
          property: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
      contractResidents: {
        where: { leftAt: null },
        orderBy: [{ joinedAt: 'asc' as const }, { userId: 'asc' as const }],
        select: {
          userId: true,
          joinedAt: true,
          user: {
            select: USER_SUMMARY_SELECT,
          },
        },
      },
    };

    if (!includePendingInvitations) {
      const row = await prisma.contract.findUnique({
        where: { id: contractId },
        select: baseSelect,
      });

      if (!row) {
        return null;
      }

      return {
        ...row,
        residentInvitations: [],
      };
    }

    return prisma.contract.findUnique({
      where: { id: contractId },
      select: {
        ...baseSelect,
        residentInvitations: {
          where: {
            status: RESIDENT_INVITATION_STATUS.PENDING,
            expiresAt: { gt: now },
          },
          orderBy: [{ expiresAt: 'desc' as const }, { id: 'desc' as const }],
          select: {
            id: true,
            status: true,
            expiresAt: true,
            invitedUser: {
              select: USER_SUMMARY_SELECT,
            },
            invitedBy: {
              select: USER_SUMMARY_SELECT,
            },
          },
        },
      },
    });
  }

  public static async expireUserPendingInvitations(
    invitedUserId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const result = await prisma.residentInvitation.updateMany({
      where: {
        invitedUserId,
        status: RESIDENT_INVITATION_STATUS.PENDING,
        expiresAt: { lte: now },
      },
      data: {
        status: RESIDENT_INVITATION_STATUS.EXPIRED,
      },
    });

    return result.count;
  }

  public static async findReceivedInvitations(
    invitedUserId: string,
    query: ResidentInvitationListQuery,
  ): Promise<{ items: ReceivedInvitationRow[]; total: number }> {
    const where: Prisma.ResidentInvitationWhereInput = {
      invitedUserId,
      ...(query.status ? { status: query.status } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.residentInvitation.findMany({
        where,
        orderBy: [{ expiresAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          contractId: true,
          status: true,
          expiresAt: true,
          acceptedAt: true,
          contract: {
            select: {
              room: {
                select: {
                  id: true,
                  roomCode: true,
                  maxOccupants: true,
                  property: {
                    select: {
                      id: true,
                      name: true,
                      address: true,
                    },
                  },
                },
              },
            },
          },
          invitedBy: {
            select: USER_SUMMARY_SELECT,
          },
        },
      }),
      prisma.residentInvitation.count({ where }),
    ]);

    return { items, total };
  }

  public static async findInvitationAccessContext(
    invitationId: string,
  ): Promise<InvitationAccessContext | null> {
    const invitation = await prisma.residentInvitation.findUnique({
      where: { id: invitationId },
      select: {
        id: true,
        contractId: true,
        invitedUserId: true,
        invitedById: true,
        contract: {
          select: {
            tenantId: true,
            room: {
              select: {
                property: {
                  select: {
                    landlordId: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!invitation) {
      return null;
    }

    return {
      invitationId: invitation.id,
      contractId: invitation.contractId,
      invitedUserId: invitation.invitedUserId,
      invitedById: invitation.invitedById,
      contractTenantId: invitation.contract.tenantId,
      landlordId: invitation.contract.room.property.landlordId,
    };
  }

  public static async findContractForMutation(
    tx: Prisma.TransactionClient,
    contractId: string,
  ): Promise<ContractMutationRow | null> {
    return tx.contract.findUnique({
      where: { id: contractId },
      select: CONTRACT_MUTATION_SELECT,
    });
  }

  public static async findUserByInviteIdentifier(
    tx: Prisma.TransactionClient,
    identifier: ParsedInviteIdentifier,
  ): Promise<InviteTargetUserRow | null> {
    if (identifier.type === 'EMAIL') {
      return tx.user.findFirst({
        where: {
          email: {
            equals: identifier.value,
            mode: 'insensitive',
          },
        },
        select: {
          ...USER_SUMMARY_SELECT,
          role: true,
          accountStatus: true,
        },
      });
    }

    return tx.user.findUnique({
      where: {
        phone: identifier.value,
      },
      select: {
        ...USER_SUMMARY_SELECT,
        role: true,
        accountStatus: true,
      },
    });
  }

  public static async findContractResident(
    tx: Prisma.TransactionClient,
    contractId: string,
    userId: string,
  ): Promise<ContractResidentRow | null> {
    return tx.contractResident.findUnique({
      where: {
        contractId_userId: {
          contractId,
          userId,
        },
      },
      select: {
        joinedAt: true,
        leftAt: true,
        user: {
          select: {
            id: true,
            fullName: true,
          },
        },
      },
    });
  }

  public static async expireContractInvitationsForUser(
    tx: Prisma.TransactionClient,
    contractId: string,
    invitedUserId: string,
    now: Date,
  ): Promise<number> {
    const result = await tx.residentInvitation.updateMany({
      where: {
        contractId,
        invitedUserId,
        status: RESIDENT_INVITATION_STATUS.PENDING,
        expiresAt: { lte: now },
      },
      data: {
        status: RESIDENT_INVITATION_STATUS.EXPIRED,
      },
    });

    return result.count;
  }

  public static async findActivePendingInvitation(
    tx: Prisma.TransactionClient,
    contractId: string,
    invitedUserId: string,
    now: Date,
  ): Promise<{ id: string } | null> {
    return tx.residentInvitation.findFirst({
      where: {
        contractId,
        invitedUserId,
        status: RESIDENT_INVITATION_STATUS.PENDING,
        expiresAt: { gt: now },
      },
      select: {
        id: true,
      },
    });
  }

  public static async countActiveCoResidents(
    tx: Prisma.TransactionClient,
    contractId: string,
  ): Promise<number> {
    return tx.contractResident.count({
      where: {
        contractId,
        leftAt: null,
      },
    });
  }

  public static async createResidentInvitation(
    tx: Prisma.TransactionClient,
    data: {
      contractId: string;
      invitedUserId: string;
      invitedById: string;
      expiresAt: Date;
    },
  ): Promise<CreatedInvitationRow> {
    return tx.residentInvitation.create({
      data: {
        contractId: data.contractId,
        invitedUserId: data.invitedUserId,
        invitedById: data.invitedById,
        status: RESIDENT_INVITATION_STATUS.PENDING,
        expiresAt: data.expiresAt,
      },
      select: {
        id: true,
        contractId: true,
        status: true,
        expiresAt: true,
        invitedUser: {
          select: USER_SUMMARY_SELECT,
        },
        invitedBy: {
          select: USER_SUMMARY_SELECT,
        },
      },
    });
  }

  public static async findInvitationContractId(
    tx: Prisma.TransactionClient,
    invitationId: string,
  ): Promise<{ contractId: string } | null> {
    return tx.residentInvitation.findUnique({
      where: { id: invitationId },
      select: { contractId: true },
    });
  }

  public static async findInvitationForMutation(
    tx: Prisma.TransactionClient,
    invitationId: string,
  ): Promise<LockedInvitationRow | null> {
    return tx.residentInvitation.findUnique({
      where: { id: invitationId },
      select: INVITATION_MUTATION_SELECT,
    });
  }

  public static async updateInvitationStatus(
    tx: Prisma.TransactionClient,
    invitationId: string,
    data: {
      status: ResidentInvitationStatus;
      acceptedAt?: Date;
    },
  ): Promise<void> {
    await tx.residentInvitation.update({
      where: { id: invitationId },
      data: {
        status: data.status,
        ...(data.acceptedAt !== undefined ? { acceptedAt: data.acceptedAt } : {}),
      },
    });
  }

  public static async upsertContractResident(
    tx: Prisma.TransactionClient,
    data: {
      contractId: string;
      userId: string;
      joinedAt: Date;
      leftAt: Date | null;
    },
  ): Promise<void> {
    await tx.contractResident.upsert({
      where: {
        contractId_userId: {
          contractId: data.contractId,
          userId: data.userId,
        },
      },
      create: {
        contractId: data.contractId,
        userId: data.userId,
        joinedAt: data.joinedAt,
        leftAt: data.leftAt,
      },
      update: {
        joinedAt: data.joinedAt,
        leftAt: data.leftAt,
      },
    });
  }

  public static async markResidentLeft(
    tx: Prisma.TransactionClient,
    contractId: string,
    userId: string,
    leftAt: Date,
  ): Promise<void> {
    await tx.contractResident.update({
      where: {
        contractId_userId: {
          contractId,
          userId,
        },
      },
      data: {
        leftAt,
      },
    });
  }
}
