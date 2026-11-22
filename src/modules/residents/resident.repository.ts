import type { Prisma } from '@prisma/client';
import {
  CONTRACT_STATUS,
  NOTIFICATION_EVENT_TYPE,
  PHASE3_TIME_LIMITS_MS,
  RESIDENT_INVITATION_STATUS,
} from '../../common/constants/phase3-status';
import { ApiError } from '../../common/errors/api-error';
import { recordAuditLog } from '../../common/utils/audit-log.util';
import {
  createNotification,
  createNotificationsBatch,
  type CreateNotificationInput,
} from '../../common/utils/notification.util';
import { prisma } from '../../infrastructure/database/prisma';
import type {
  AcceptInvitationOutcome,
  AcceptInvitationTxParams,
  CancelInvitationOutcome,
  CancelInvitationTxParams,
  ContractAccessContext,
  ContractResidentsRow,
  CreatedInvitationRow,
  CreateInvitationTxParams,
  InvitationAccessContext,
  ReceivedInvitationRow,
  RejectInvitationOutcome,
  RejectInvitationTxParams,
  RemovedResidentTxResult,
  RemoveResidentTxParams,
  ResidentInvitationListQuery,
} from './resident.types';

const USER_SUMMARY_SELECT = {
  id: true,
  fullName: true,
  avatarUrl: true,
} as const;

/**
 * Khóa hàng hợp đồng theo một thứ tự duy nhất (contracts FOR UPDATE)
 * để tuần tự hóa toàn bộ thao tác ghi cư trú và triệt tiêu deadlock/race condition.
 */
async function lockContractRow(tx: Prisma.TransactionClient, contractId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM contracts WHERE id = ${contractId}::uuid FOR UPDATE
  `;
  return rows.length > 0;
}

/**
 * Giới hạn tiêu đề Notification <= 160 ký tự (an toàn dưới VARCHAR(200) của PostgreSQL)
 * trong khi nội dung đầy đủ được lưu trong payload.content (JsonB).
 */
export function formatNotificationTitle(title: string, maxLength = 160): string {
  const trimmed = title.trim();
  const codePoints = [...trimmed];
  if (codePoints.length <= maxLength) {
    return trimmed;
  }
  return `${codePoints.slice(0, maxLength - 3).join('').trimEnd()}...`;
}

const LOCKED_INVITATION_SELECT = {
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
    select: {
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
    },
  },
} as const;

type LockedInvitationRow = Prisma.ResidentInvitationGetPayload<{
  select: typeof LOCKED_INVITATION_SELECT;
}>;

type LoadedPendingInvitationResult =
  | { outcome: 'EXPIRED' }
  | { outcome: 'READY'; invitation: LockedInvitationRow };

/**
 * Khóa hàng Contract cha trước khi đọc lại lời mời để kiểm tra quyền, trạng thái PENDING
 * và thực hiện lazy-expire an toàn (commit EXPIRED thay vì throw trong transaction).
 */
async function loadLockedPendingInvitation(
  tx: Prisma.TransactionClient,
  invitationId: string,
  now: Date,
  isAuthorized: (invitation: LockedInvitationRow) => boolean,
): Promise<LoadedPendingInvitationResult> {
  const invitationMeta = await tx.residentInvitation.findUnique({
    where: { id: invitationId },
    select: { contractId: true },
  });

  if (!invitationMeta) {
    throw new ApiError(
      404,
      'INVITATION_NOT_FOUND',
      'Lời mời ở cùng không tồn tại hoặc bạn không có quyền truy cập',
    );
  }

  await lockContractRow(tx, invitationMeta.contractId);

  const invitation = await tx.residentInvitation.findUnique({
    where: { id: invitationId },
    select: LOCKED_INVITATION_SELECT,
  });

  if (!invitation || !isAuthorized(invitation)) {
    throw new ApiError(
      404,
      'INVITATION_NOT_FOUND',
      'Lời mời ở cùng không tồn tại hoặc bạn không có quyền truy cập',
    );
  }

  if (invitation.status === RESIDENT_INVITATION_STATUS.EXPIRED) {
    throw new ApiError(409, 'INVITATION_EXPIRED', 'Lời mời ở cùng đã hết hạn sau 72 giờ');
  }

  if (invitation.status !== RESIDENT_INVITATION_STATUS.PENDING) {
    throw new ApiError(
      409,
      'INVITATION_NOT_PENDING',
      'Lời mời không còn ở trạng thái chờ phản hồi (PENDING)',
    );
  }

  // Commit EXPIRED status cleanly before throwing 409 in the service layer.
  if (invitation.expiresAt <= now) {
    await tx.residentInvitation.update({
      where: { id: invitation.id },
      data: { status: RESIDENT_INVITATION_STATUS.EXPIRED },
    });
    return { outcome: 'EXPIRED' };
  }

  return { outcome: 'READY', invitation };
}

export class ResidentRepository {
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

  public static async createInvitationInTx(
    params: CreateInvitationTxParams,
  ): Promise<CreatedInvitationRow> {
    const now = params.now ?? new Date();

    return prisma.$transaction(async (tx) => {
      const locked = await lockContractRow(tx, params.contractId);
      if (!locked) {
        throw new ApiError(
          404,
          'CONTRACT_NOT_FOUND',
          'Hợp đồng không tồn tại hoặc bạn không có quyền truy cập',
        );
      }

      const contract = await tx.contract.findUnique({
        where: { id: params.contractId },
        select: {
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
        },
      });

      if (!contract) {
        throw new ApiError(
          404,
          'CONTRACT_NOT_FOUND',
          'Hợp đồng không tồn tại hoặc bạn không có quyền truy cập',
        );
      }

      if (
        params.invitedById !== contract.tenantId &&
        params.invitedById !== contract.room.property.landlordId
      ) {
        throw new ApiError(403, 'FORBIDDEN', 'Bạn không có quyền thực hiện thao tác này');
      }

      if (contract.status !== CONTRACT_STATUS.ACTIVE) {
        throw new ApiError(
          409,
          'CONTRACT_NOT_ACTIVE',
          'Chỉ có thể thực hiện thao tác khi hợp đồng đang ở trạng thái ACTIVE',
        );
      }

      const targetUser =
        params.identifier.type === 'EMAIL'
          ? await tx.user.findFirst({
              where: {
                email: {
                  equals: params.identifier.value,
                  mode: 'insensitive',
                },
              },
              select: {
                ...USER_SUMMARY_SELECT,
                role: true,
                accountStatus: true,
              },
            })
          : await tx.user.findUnique({
              where: {
                phone: params.identifier.value,
              },
              select: {
                ...USER_SUMMARY_SELECT,
                role: true,
                accountStatus: true,
              },
            });

      if (!targetUser) {
        throw new ApiError(
          404,
          'INVITEE_NOT_FOUND',
          'Không tìm thấy tài khoản RentMate tương ứng với email hoặc số điện thoại này',
        );
      }

      if (targetUser.role !== 'TENANT' || targetUser.accountStatus !== 'ACTIVE') {
        throw new ApiError(
          400,
          'INVITEE_NOT_ELIGIBLE',
          'Tài khoản được mời phải là người thuê (TENANT) đang hoạt động',
        );
      }

      if (targetUser.id === contract.tenantId) {
        throw new ApiError(
          409,
          'ALREADY_PRIMARY_TENANT',
          'Không thể mời chính chủ hợp đồng của phòng này',
        );
      }

      const existingResident = await tx.contractResident.findUnique({
        where: {
          contractId_userId: {
            contractId: contract.id,
            userId: targetUser.id,
          },
        },
        select: {
          leftAt: true,
        },
      });

      if (existingResident && existingResident.leftAt === null) {
        throw new ApiError(
          409,
          'ALREADY_RESIDENT',
          'Người dùng này hiện đang là thành viên cư trú của hợp đồng',
        );
      }

      await tx.residentInvitation.updateMany({
        where: {
          contractId: contract.id,
          invitedUserId: targetUser.id,
          status: RESIDENT_INVITATION_STATUS.PENDING,
          expiresAt: { lte: now },
        },
        data: {
          status: RESIDENT_INVITATION_STATUS.EXPIRED,
        },
      });

      const activePendingInvitation = await tx.residentInvitation.findFirst({
        where: {
          contractId: contract.id,
          invitedUserId: targetUser.id,
          status: RESIDENT_INVITATION_STATUS.PENDING,
          expiresAt: { gt: now },
        },
        select: {
          id: true,
        },
      });

      if (activePendingInvitation) {
        throw new ApiError(
          409,
          'INVITATION_ALREADY_PENDING',
          'Người dùng này đã có một lời mời ở cùng đang chờ phản hồi cho hợp đồng này',
        );
      }

      const activeCoResidents = await tx.contractResident.count({
        where: {
          contractId: contract.id,
          leftAt: null,
        },
      });

      if (1 + activeCoResidents >= contract.room.maxOccupants) {
        throw new ApiError(
          409,
          'ROOM_CAPACITY_EXCEEDED',
          'Phòng đã đạt số lượng người ở tối đa theo quy định (BR-11)',
        );
      }

      const expiresAt = new Date(
        now.getTime() + PHASE3_TIME_LIMITS_MS.RESIDENT_INVITATION_TTL_MS,
      );

      const invitation = await tx.residentInvitation.create({
        data: {
          contractId: contract.id,
          invitedUserId: targetUser.id,
          invitedById: params.invitedById,
          status: RESIDENT_INVITATION_STATUS.PENDING,
          expiresAt,
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

      await createNotification(tx, {
        recipientId: targetUser.id,
        title: formatNotificationTitle(`Lời mời ở cùng phòng ${contract.room.roomCode}`),
        eventType: NOTIFICATION_EVENT_TYPE.RESIDENT_INVITATION_RECEIVED,
        payload: {
          content: `${invitation.invitedBy.fullName} đã mời bạn ở cùng phòng ${contract.room.roomCode}`,
          actionUrl: '/resident-invitations',
          relatedEntityType: 'RESIDENT_INVITATION',
          relatedEntityId: invitation.id,
          metadata: {
            contractId: contract.id,
            roomId: contract.room.id,
            roomCode: contract.room.roomCode,
            invitationId: invitation.id,
            invitedById: params.invitedById,
            expiresAt: expiresAt.toISOString(),
          },
        },
      });

      await recordAuditLog(tx, {
        actorId: params.invitedById,
        entityType: 'RESIDENT_INVITATION',
        entityId: invitation.id,
        action: 'RESIDENT_INVITATION_CREATED',
        oldData: null,
        newData: {
          contractId: contract.id,
          invitedUserId: targetUser.id,
          invitedById: params.invitedById,
          status: RESIDENT_INVITATION_STATUS.PENDING,
          expiresAt: expiresAt.toISOString(),
        },
      });

      return invitation;
    });
  }

  public static async findReceivedInvitations(
    invitedUserId: string,
    query: ResidentInvitationListQuery,
    now: Date = new Date(),
  ): Promise<{ items: ReceivedInvitationRow[]; total: number }> {
    await prisma.residentInvitation.updateMany({
      where: {
        invitedUserId,
        status: RESIDENT_INVITATION_STATUS.PENDING,
        expiresAt: { lte: now },
      },
      data: {
        status: RESIDENT_INVITATION_STATUS.EXPIRED,
      },
    });

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

  public static async acceptInvitationInTx(
    params: AcceptInvitationTxParams,
  ): Promise<AcceptInvitationOutcome> {
    const now = params.now ?? new Date();

    return prisma.$transaction(async (tx) => {
      const loaded = await loadLockedPendingInvitation(
        tx,
        params.invitationId,
        now,
        (row) => row.invitedUserId === params.actorId,
      );
      if (loaded.outcome === 'EXPIRED') {
        return { outcome: 'EXPIRED' };
      }
      const { invitation } = loaded;

      if (invitation.contract.status !== CONTRACT_STATUS.ACTIVE) {
        throw new ApiError(
          409,
          'CONTRACT_NOT_ACTIVE',
          'Chỉ có thể chấp nhận lời mời khi hợp đồng đang ở trạng thái ACTIVE',
        );
      }

      if (params.actorId === invitation.contract.tenantId) {
        throw new ApiError(
          409,
          'ALREADY_PRIMARY_TENANT',
          'Không thể mời chính chủ hợp đồng của phòng này',
        );
      }

      const existingResident = await tx.contractResident.findUnique({
        where: {
          contractId_userId: {
            contractId: invitation.contractId,
            userId: params.actorId,
          },
        },
        select: {
          joinedAt: true,
          leftAt: true,
        },
      });

      if (existingResident && existingResident.leftAt === null) {
        throw new ApiError(
          409,
          'ALREADY_RESIDENT',
          'Bạn hiện đã là thành viên cư trú của hợp đồng này',
        );
      }

      const activeCoResidents = await tx.contractResident.count({
        where: {
          contractId: invitation.contractId,
          leftAt: null,
        },
      });

      if (1 + activeCoResidents >= invitation.contract.room.maxOccupants) {
        throw new ApiError(
          409,
          'ROOM_CAPACITY_EXCEEDED',
          'Phòng đã đạt số lượng người ở tối đa theo quy định (BR-11)',
        );
      }

      await tx.contractResident.upsert({
        where: {
          contractId_userId: {
            contractId: invitation.contractId,
            userId: params.actorId,
          },
        },
        create: {
          contractId: invitation.contractId,
          userId: params.actorId,
          joinedAt: now,
          leftAt: null,
        },
        update: {
          joinedAt: now,
          leftAt: null,
        },
      });

      await tx.residentInvitation.update({
        where: { id: invitation.id },
        data: {
          status: RESIDENT_INVITATION_STATUS.ACCEPTED,
          acceptedAt: now,
        },
      });

      const currentOccupants = 1 + activeCoResidents + 1;
      const roomCode = invitation.contract.room.roomCode;
      const residentName = invitation.invitedUser.fullName;

      const recipients = new Map<string, CreateNotificationInput>();
      recipients.set(invitation.contract.tenantId, {
        recipientId: invitation.contract.tenantId,
        title: formatNotificationTitle(`${residentName} đã tham gia phòng ${roomCode}`),
        eventType: NOTIFICATION_EVENT_TYPE.RESIDENT_JOINED,
        payload: {
          content: `${residentName} đã chấp nhận lời mời và tham gia phòng ${roomCode}`,
          actionUrl: `/contracts/${invitation.contractId}/residents`,
          relatedEntityType: 'CONTRACT',
          relatedEntityId: invitation.contractId,
          metadata: {
            contractId: invitation.contractId,
            roomId: invitation.contract.room.id,
            roomCode,
            invitationId: invitation.id,
            residentUserId: params.actorId,
            currentOccupants,
            maxOccupants: invitation.contract.room.maxOccupants,
          },
        },
      });

      if (!recipients.has(invitation.contract.room.property.landlordId)) {
        recipients.set(invitation.contract.room.property.landlordId, {
          recipientId: invitation.contract.room.property.landlordId,
          title: formatNotificationTitle(`${residentName} đã tham gia phòng ${roomCode}`),
          eventType: NOTIFICATION_EVENT_TYPE.RESIDENT_JOINED,
          payload: {
            content: `${residentName} đã chấp nhận lời mời và tham gia phòng ${roomCode}`,
            actionUrl: `/landlord/contracts/${invitation.contractId}/residents`,
            relatedEntityType: 'CONTRACT',
            relatedEntityId: invitation.contractId,
            metadata: {
              contractId: invitation.contractId,
              roomId: invitation.contract.room.id,
              roomCode,
              invitationId: invitation.id,
              residentUserId: params.actorId,
              currentOccupants,
              maxOccupants: invitation.contract.room.maxOccupants,
            },
          },
        });
      }

      await createNotificationsBatch(tx, Array.from(recipients.values()));

      await recordAuditLog(tx, {
        actorId: params.actorId,
        entityType: 'RESIDENT_INVITATION',
        entityId: invitation.id,
        action: 'RESIDENT_INVITATION_ACCEPTED',
        oldData: {
          status: RESIDENT_INVITATION_STATUS.PENDING,
          previousResident: existingResident
            ? {
                joinedAt: existingResident.joinedAt.toISOString(),
                leftAt: existingResident.leftAt ? existingResident.leftAt.toISOString() : null,
              }
            : null,
        },
        newData: {
          status: RESIDENT_INVITATION_STATUS.ACCEPTED,
          acceptedAt: now.toISOString(),
          contractId: invitation.contractId,
          userId: params.actorId,
          joinedAt: now.toISOString(),
          leftAt: null,
          currentOccupants,
        },
      });

      return {
        outcome: 'ACCEPTED',
        data: {
          invitationId: invitation.id,
          contractId: invitation.contractId,
          acceptedAt: now,
          resident: {
            user: invitation.invitedUser,
            joinedAt: now,
          },
          currentOccupants,
          maxOccupants: invitation.contract.room.maxOccupants,
        },
      };
    });
  }

  public static async rejectInvitationInTx(
    params: RejectInvitationTxParams,
  ): Promise<RejectInvitationOutcome> {
    const now = params.now ?? new Date();

    return prisma.$transaction(async (tx) => {
      const loaded = await loadLockedPendingInvitation(
        tx,
        params.invitationId,
        now,
        (row) => row.invitedUserId === params.actorId,
      );
      if (loaded.outcome === 'EXPIRED') {
        return { outcome: 'EXPIRED' };
      }
      const { invitation } = loaded;

      await tx.residentInvitation.update({
        where: { id: invitation.id },
        data: { status: RESIDENT_INVITATION_STATUS.REJECTED },
      });

      const roomCode = invitation.contract.room.roomCode;
      const inviteeName = invitation.invitedUser.fullName;
      const isInviterLandlord =
        invitation.invitedById === invitation.contract.room.property.landlordId;

      await createNotification(tx, {
        recipientId: invitation.invitedById,
        title: formatNotificationTitle(`${inviteeName} đã từ chối lời mời phòng ${roomCode}`),
        eventType: NOTIFICATION_EVENT_TYPE.RESIDENT_INVITATION_REJECTED,
        payload: {
          content: `${inviteeName} đã từ chối lời mời ở cùng phòng ${roomCode}`,
          actionUrl: isInviterLandlord
            ? `/landlord/contracts/${invitation.contractId}/residents`
            : `/contracts/${invitation.contractId}/residents`,
          relatedEntityType: 'RESIDENT_INVITATION',
          relatedEntityId: invitation.id,
          metadata: {
            contractId: invitation.contractId,
            roomId: invitation.contract.room.id,
            roomCode,
            invitationId: invitation.id,
            invitedUserId: invitation.invitedUserId,
          },
        },
      });

      await recordAuditLog(tx, {
        actorId: params.actorId,
        entityType: 'RESIDENT_INVITATION',
        entityId: invitation.id,
        action: 'RESIDENT_INVITATION_REJECTED',
        oldData: {
          status: RESIDENT_INVITATION_STATUS.PENDING,
        },
        newData: {
          status: RESIDENT_INVITATION_STATUS.REJECTED,
          contractId: invitation.contractId,
          invitedUserId: invitation.invitedUserId,
        },
      });

      return {
        outcome: 'REJECTED',
        data: {
          invitationId: invitation.id,
          contractId: invitation.contractId,
        },
      };
    });
  }

  public static async cancelInvitationInTx(
    params: CancelInvitationTxParams,
  ): Promise<CancelInvitationOutcome> {
    const now = params.now ?? new Date();

    return prisma.$transaction(async (tx) => {
      const loaded = await loadLockedPendingInvitation(
        tx,
        params.invitationId,
        now,
        (row) =>
          params.actorId === row.invitedById ||
          params.actorId === row.contract.tenantId ||
          params.actorId === row.contract.room.property.landlordId,
      );
      if (loaded.outcome === 'EXPIRED') {
        return { outcome: 'EXPIRED' };
      }
      const { invitation } = loaded;

      await tx.residentInvitation.update({
        where: { id: invitation.id },
        data: { status: RESIDENT_INVITATION_STATUS.CANCELLED },
      });

      const roomCode = invitation.contract.room.roomCode;

      await createNotification(tx, {
        recipientId: invitation.invitedUserId,
        title: formatNotificationTitle(`Lời mời ở cùng phòng ${roomCode} đã bị thu hồi`),
        eventType: NOTIFICATION_EVENT_TYPE.RESIDENT_INVITATION_CANCELLED,
        payload: {
          content: `Lời mời ở cùng phòng ${roomCode} đã bị người gửi hoặc quản lý phòng thu hồi`,
          actionUrl: '/resident-invitations',
          relatedEntityType: 'RESIDENT_INVITATION',
          relatedEntityId: invitation.id,
          metadata: {
            contractId: invitation.contractId,
            roomId: invitation.contract.room.id,
            roomCode,
            invitationId: invitation.id,
            cancelledById: params.actorId,
          },
        },
      });

      await recordAuditLog(tx, {
        actorId: params.actorId,
        entityType: 'RESIDENT_INVITATION',
        entityId: invitation.id,
        action: 'RESIDENT_INVITATION_CANCELLED',
        oldData: {
          status: RESIDENT_INVITATION_STATUS.PENDING,
        },
        newData: {
          status: RESIDENT_INVITATION_STATUS.CANCELLED,
          contractId: invitation.contractId,
          invitedUserId: invitation.invitedUserId,
          cancelledById: params.actorId,
        },
      });

      return {
        outcome: 'CANCELLED',
        data: {
          invitationId: invitation.id,
          contractId: invitation.contractId,
        },
      };
    });
  }

  public static async removeResidentInTx(
    params: RemoveResidentTxParams,
  ): Promise<RemovedResidentTxResult> {
    const now = params.now ?? new Date();

    return prisma.$transaction(async (tx) => {
      const locked = await lockContractRow(tx, params.contractId);
      if (!locked) {
        throw new ApiError(
          404,
          'CONTRACT_NOT_FOUND',
          'Hợp đồng không tồn tại hoặc bạn không có quyền truy cập',
        );
      }

      const contract = await tx.contract.findUnique({
        where: { id: params.contractId },
        select: {
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
                  landlordId: true,
                },
              },
            },
          },
        },
      });

      if (!contract) {
        throw new ApiError(
          404,
          'CONTRACT_NOT_FOUND',
          'Hợp đồng không tồn tại hoặc bạn không có quyền truy cập',
        );
      }

      if (params.targetUserId === contract.tenantId) {
        throw new ApiError(
          400,
          'CANNOT_REMOVE_PRIMARY_TENANT',
          'Không thể gỡ Chủ hợp đồng khỏi danh sách cư trú (BR-10)',
        );
      }

      if (contract.status !== CONTRACT_STATUS.ACTIVE) {
        throw new ApiError(
          409,
          'CONTRACT_NOT_ACTIVE',
          'Chỉ có thể gỡ người ở cùng khi hợp đồng đang ở trạng thái ACTIVE',
        );
      }

      const resident = await tx.contractResident.findFirst({
        where: {
          contractId: contract.id,
          userId: params.targetUserId,
          leftAt: null,
        },
        select: {
          joinedAt: true,
          user: {
            select: {
              id: true,
              fullName: true,
            },
          },
        },
      });

      if (!resident) {
        throw new ApiError(
          404,
          'RESIDENT_NOT_FOUND',
          'Người dùng không phải là người ở cùng đang cư trú của hợp đồng này',
        );
      }

      await tx.contractResident.update({
        where: {
          contractId_userId: {
            contractId: contract.id,
            userId: params.targetUserId,
          },
        },
        data: {
          leftAt: now,
        },
      });

      const activeCoResidentsAfter = await tx.contractResident.count({
        where: {
          contractId: contract.id,
          leftAt: null,
        },
      });
      const currentOccupants = 1 + activeCoResidentsAfter;
      const roomCode = contract.room.roomCode;
      const residentName = resident.user.fullName;
      const isSelfLeave = params.removalType === 'SELF_LEAVE';
      const title = formatNotificationTitle(
        isSelfLeave
          ? `${residentName} đã rời phòng ${roomCode}`
          : `${residentName} đã được gỡ khỏi phòng ${roomCode}`,
      );
      const content = isSelfLeave
        ? `${residentName} đã chủ động rời khỏi danh sách cư trú phòng ${roomCode}`
        : `${residentName} đã được gỡ khỏi danh sách cư trú phòng ${roomCode}`;

      const recipients = new Map<string, CreateNotificationInput>();
      const buildPayload = (actionUrl: string): Prisma.InputJsonValue => ({
        content,
        actionUrl,
        relatedEntityType: 'CONTRACT',
        relatedEntityId: contract.id,
        metadata: {
          contractId: contract.id,
          roomId: contract.room.id,
          roomCode,
          userId: params.targetUserId,
          removalType: params.removalType,
          currentOccupants,
          maxOccupants: contract.room.maxOccupants,
        },
      });

      recipients.set(contract.room.property.landlordId, {
        recipientId: contract.room.property.landlordId,
        title,
        eventType: NOTIFICATION_EVENT_TYPE.RESIDENT_REMOVED,
        payload: buildPayload(`/landlord/contracts/${contract.id}/residents`),
      });

      if (!recipients.has(contract.tenantId)) {
        recipients.set(contract.tenantId, {
          recipientId: contract.tenantId,
          title,
          eventType: NOTIFICATION_EVENT_TYPE.RESIDENT_REMOVED,
          payload: buildPayload(`/contracts/${contract.id}/residents`),
        });
      }

      if (!recipients.has(params.targetUserId)) {
        recipients.set(params.targetUserId, {
          recipientId: params.targetUserId,
          title,
          eventType: NOTIFICATION_EVENT_TYPE.RESIDENT_REMOVED,
          payload: buildPayload('/contracts'),
        });
      }

      await createNotificationsBatch(tx, Array.from(recipients.values()));

      await recordAuditLog(tx, {
        actorId: params.actorId,
        entityType: 'CONTRACT_RESIDENT',
        entityId: contract.id,
        action: isSelfLeave ? 'RESIDENT_SELF_LEFT' : 'RESIDENT_REMOVED',
        oldData: {
          contractId: contract.id,
          userId: params.targetUserId,
          joinedAt: resident.joinedAt.toISOString(),
          leftAt: null,
        },
        newData: {
          contractId: contract.id,
          userId: params.targetUserId,
          joinedAt: resident.joinedAt.toISOString(),
          leftAt: now.toISOString(),
          removalType: params.removalType,
          currentOccupants,
        },
      });

      return {
        contractId: contract.id,
        userId: params.targetUserId,
        leftAt: now,
        removalType: params.removalType,
        currentOccupants,
        maxOccupants: contract.room.maxOccupants,
      };
    });
  }
}
