import type { Prisma } from '@prisma/client';
import {
  CONTRACT_STATUS,
  NOTIFICATION_EVENT_TYPE,
  PHASE3_TIME_LIMITS_MS,
  RESIDENT_INVITATION_STATUS,
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
import {
  mapAcceptInvitationResponse,
  mapContractResidentsResponse,
  mapCreatedInvitationResponse,
  mapInvitationStatusActionResponse,
  mapReceivedInvitationItem,
  mapRemoveResidentResponse,
} from './resident.mapper';
import { ResidentRepository } from './resident.repository';
import type {
  AcceptInvitationOutcome,
  AcceptResidentInvitationDTO,
  CancelInvitationOutcome,
  ContractResidentsResponseDTO,
  InvitationStatusActionDTO,
  LockedInvitationRow,
  PaginatedResidentInvitationsDTO,
  ParsedInviteIdentifier,
  RejectInvitationOutcome,
  RemoveContractResidentDTO,
  RemovedResidentTxResult,
  ResidentInvitationCreatedDTO,
  ResidentInvitationListQuery,
  ResidentRemovalType,
} from './resident.types';

const CONTRACT_NOT_FOUND_MESSAGE = 'Hợp đồng không tồn tại hoặc bạn không có quyền truy cập';
const INVITATION_NOT_FOUND_MESSAGE = 'Lời mời ở cùng không tồn tại hoặc bạn không có quyền truy cập';
const INVITATION_EXPIRED_MESSAGE = 'Lời mời ở cùng đã hết hạn sau 72 giờ';

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

type LoadedPendingInvitationResult =
  | { outcome: 'EXPIRED' }
  | { outcome: 'READY'; invitation: LockedInvitationRow };

export class ResidentService {
  /**
   * Khóa hàng Contract cha trước khi đọc lại lời mời để kiểm tra quyền, trạng thái PENDING
   * và thực hiện lazy-expire an toàn (commit EXPIRED thay vì throw trong transaction).
   */
  private static async loadLockedPendingInvitationInTx(
    tx: Prisma.TransactionClient,
    invitationId: string,
    now: Date,
    isAuthorized: (invitation: LockedInvitationRow) => boolean,
  ): Promise<LoadedPendingInvitationResult> {
    const invitationMeta = await ResidentRepository.findInvitationContractId(tx, invitationId);
    if (!invitationMeta) {
      throw new ApiError(404, 'INVITATION_NOT_FOUND', INVITATION_NOT_FOUND_MESSAGE);
    }

    await ResidentRepository.lockContractRow(tx, invitationMeta.contractId);

    const invitation = await ResidentRepository.findInvitationForMutation(tx, invitationId);
    if (!invitation || !isAuthorized(invitation)) {
      throw new ApiError(404, 'INVITATION_NOT_FOUND', INVITATION_NOT_FOUND_MESSAGE);
    }

    if (invitation.status === RESIDENT_INVITATION_STATUS.EXPIRED) {
      throw new ApiError(409, 'INVITATION_EXPIRED', INVITATION_EXPIRED_MESSAGE);
    }

    if (invitation.status !== RESIDENT_INVITATION_STATUS.PENDING) {
      throw new ApiError(
        409,
        'INVITATION_NOT_PENDING',
        'Lời mời không còn ở trạng thái chờ phản hồi (PENDING)',
      );
    }

    // Commit EXPIRED status cleanly before throwing 409 outside the transaction.
    if (invitation.expiresAt <= now) {
      await ResidentRepository.updateInvitationStatus(tx, invitation.id, {
        status: RESIDENT_INVITATION_STATUS.EXPIRED,
      });
      return { outcome: 'EXPIRED' };
    }

    return { outcome: 'READY', invitation };
  }

  public static async getContractResidents(
    contractId: string,
    currentUser: CurrentUser,
  ): Promise<ContractResidentsResponseDTO> {
    const context = await ResidentRepository.findContractAccessContext(contractId, currentUser.id);
    if (!context) {
      throw new ApiError(404, 'CONTRACT_NOT_FOUND', CONTRACT_NOT_FOUND_MESSAGE);
    }

    const includePendingInvitations = context.isPrimaryTenant || context.isLandlord;
    const now = new Date();

    if (includePendingInvitations) {
      await ResidentRepository.expireContractPendingInvitations(contractId, now);
    }

    const detail = await ResidentRepository.findContractResidentsDetail(
      contractId,
      includePendingInvitations,
      now,
    );
    if (!detail) {
      throw new ApiError(404, 'CONTRACT_NOT_FOUND', CONTRACT_NOT_FOUND_MESSAGE);
    }

    return mapContractResidentsResponse(detail, includePendingInvitations);
  }

  public static async createInvitation(
    contractId: string,
    identifier: ParsedInviteIdentifier,
    currentUser: CurrentUser,
  ): Promise<ResidentInvitationCreatedDTO> {
    const context = await ResidentRepository.findContractAccessContext(contractId, currentUser.id);
    if (!context) {
      throw new ApiError(404, 'CONTRACT_NOT_FOUND', CONTRACT_NOT_FOUND_MESSAGE);
    }

    if (!context.isPrimaryTenant && !context.isLandlord) {
      throw new ApiError(403, 'FORBIDDEN', 'Bạn không có quyền thực hiện thao tác này');
    }

    const now = new Date();

    const created = await prisma.$transaction(async (tx) => {
      const locked = await ResidentRepository.lockContractRow(tx, contractId);
      if (!locked) {
        throw new ApiError(404, 'CONTRACT_NOT_FOUND', CONTRACT_NOT_FOUND_MESSAGE);
      }

      const contract = await ResidentRepository.findContractForMutation(tx, contractId);
      if (!contract) {
        throw new ApiError(404, 'CONTRACT_NOT_FOUND', CONTRACT_NOT_FOUND_MESSAGE);
      }

      if (
        currentUser.id !== contract.tenantId &&
        currentUser.id !== contract.room.property.landlordId
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

      const targetUser = await ResidentRepository.findUserByInviteIdentifier(tx, identifier);
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

      const existingResident = await ResidentRepository.findContractResident(
        tx,
        contract.id,
        targetUser.id,
      );
      if (existingResident && existingResident.leftAt === null) {
        throw new ApiError(
          409,
          'ALREADY_RESIDENT',
          'Người dùng này hiện đang là thành viên cư trú của hợp đồng',
        );
      }

      await ResidentRepository.expireContractInvitationsForUser(tx, contract.id, targetUser.id, now);

      const activePendingInvitation = await ResidentRepository.findActivePendingInvitation(
        tx,
        contract.id,
        targetUser.id,
        now,
      );
      if (activePendingInvitation) {
        throw new ApiError(
          409,
          'INVITATION_ALREADY_PENDING',
          'Người dùng này đã có một lời mời ở cùng đang chờ phản hồi cho hợp đồng này',
        );
      }

      const activeCoResidents = await ResidentRepository.countActiveCoResidents(tx, contract.id);
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

      const invitation = await ResidentRepository.createResidentInvitation(tx, {
        contractId: contract.id,
        invitedUserId: targetUser.id,
        invitedById: currentUser.id,
        expiresAt,
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
            invitedById: currentUser.id,
            expiresAt: expiresAt.toISOString(),
          },
        },
      });

      await recordAuditLog(tx, {
        actorId: currentUser.id,
        entityType: 'RESIDENT_INVITATION',
        entityId: invitation.id,
        action: 'RESIDENT_INVITATION_CREATED',
        oldData: null,
        newData: {
          contractId: contract.id,
          invitedUserId: targetUser.id,
          invitedById: currentUser.id,
          status: RESIDENT_INVITATION_STATUS.PENDING,
          expiresAt: expiresAt.toISOString(),
        },
      });

      return invitation;
    });

    return mapCreatedInvitationResponse(created);
  }

  public static async listMyInvitations(
    query: ResidentInvitationListQuery,
    currentUser: CurrentUser,
  ): Promise<PaginatedResidentInvitationsDTO> {
    const now = new Date();
    await ResidentRepository.expireUserPendingInvitations(currentUser.id, now);

    const { items, total } = await ResidentRepository.findReceivedInvitations(
      currentUser.id,
      query,
    );

    return {
      items: items.map(mapReceivedInvitationItem),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit) || 0,
    };
  }

  public static async acceptInvitation(
    invitationId: string,
    currentUser: CurrentUser,
  ): Promise<AcceptResidentInvitationDTO> {
    const context = await ResidentRepository.findInvitationAccessContext(invitationId);
    if (!context || context.invitedUserId !== currentUser.id) {
      throw new ApiError(404, 'INVITATION_NOT_FOUND', INVITATION_NOT_FOUND_MESSAGE);
    }

    const now = new Date();

    const result = await prisma.$transaction(
      async (tx): Promise<AcceptInvitationOutcome> => {
        const loaded = await ResidentService.loadLockedPendingInvitationInTx(
          tx,
          invitationId,
          now,
          (row) => row.invitedUserId === currentUser.id,
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

        if (currentUser.id === invitation.contract.tenantId) {
          throw new ApiError(
            409,
            'ALREADY_PRIMARY_TENANT',
            'Không thể mời chính chủ hợp đồng của phòng này',
          );
        }

        const existingResident = await ResidentRepository.findContractResident(
          tx,
          invitation.contractId,
          currentUser.id,
        );
        if (existingResident && existingResident.leftAt === null) {
          throw new ApiError(
            409,
            'ALREADY_RESIDENT',
            'Bạn hiện đã là thành viên cư trú của hợp đồng này',
          );
        }

        const activeCoResidents = await ResidentRepository.countActiveCoResidents(
          tx,
          invitation.contractId,
        );
        if (1 + activeCoResidents >= invitation.contract.room.maxOccupants) {
          throw new ApiError(
            409,
            'ROOM_CAPACITY_EXCEEDED',
            'Phòng đã đạt số lượng người ở tối đa theo quy định (BR-11)',
          );
        }

        await ResidentRepository.upsertContractResident(tx, {
          contractId: invitation.contractId,
          userId: currentUser.id,
          joinedAt: now,
          leftAt: null,
        });

        await ResidentRepository.updateInvitationStatus(tx, invitation.id, {
          status: RESIDENT_INVITATION_STATUS.ACCEPTED,
          acceptedAt: now,
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
              residentUserId: currentUser.id,
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
                residentUserId: currentUser.id,
                currentOccupants,
                maxOccupants: invitation.contract.room.maxOccupants,
              },
            },
          });
        }

        await createNotificationsBatch(tx, Array.from(recipients.values()));

        await recordAuditLog(tx, {
          actorId: currentUser.id,
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
            userId: currentUser.id,
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
      },
    );

    if (result.outcome === 'EXPIRED') {
      throw new ApiError(409, 'INVITATION_EXPIRED', INVITATION_EXPIRED_MESSAGE);
    }

    return mapAcceptInvitationResponse(result.data);
  }

  public static async rejectInvitation(
    invitationId: string,
    currentUser: CurrentUser,
  ): Promise<InvitationStatusActionDTO> {
    const context = await ResidentRepository.findInvitationAccessContext(invitationId);
    if (!context || context.invitedUserId !== currentUser.id) {
      throw new ApiError(404, 'INVITATION_NOT_FOUND', INVITATION_NOT_FOUND_MESSAGE);
    }

    const now = new Date();

    const result = await prisma.$transaction(
      async (tx): Promise<RejectInvitationOutcome> => {
        const loaded = await ResidentService.loadLockedPendingInvitationInTx(
          tx,
          invitationId,
          now,
          (row) => row.invitedUserId === currentUser.id,
        );
        if (loaded.outcome === 'EXPIRED') {
          return { outcome: 'EXPIRED' };
        }
        const { invitation } = loaded;

        await ResidentRepository.updateInvitationStatus(tx, invitation.id, {
          status: RESIDENT_INVITATION_STATUS.REJECTED,
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
          actorId: currentUser.id,
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
      },
    );

    if (result.outcome === 'EXPIRED') {
      throw new ApiError(409, 'INVITATION_EXPIRED', INVITATION_EXPIRED_MESSAGE);
    }

    return mapInvitationStatusActionResponse(
      result.data.invitationId,
      result.data.contractId,
      'REJECTED',
    );
  }

  public static async cancelInvitation(
    invitationId: string,
    currentUser: CurrentUser,
  ): Promise<InvitationStatusActionDTO> {
    const context = await ResidentRepository.findInvitationAccessContext(invitationId);
    const canCancel =
      context &&
      (context.invitedById === currentUser.id ||
        context.contractTenantId === currentUser.id ||
        context.landlordId === currentUser.id);

    if (!canCancel) {
      throw new ApiError(404, 'INVITATION_NOT_FOUND', INVITATION_NOT_FOUND_MESSAGE);
    }

    const now = new Date();

    const result = await prisma.$transaction(
      async (tx): Promise<CancelInvitationOutcome> => {
        const loaded = await ResidentService.loadLockedPendingInvitationInTx(
          tx,
          invitationId,
          now,
          (row) =>
            currentUser.id === row.invitedById ||
            currentUser.id === row.contract.tenantId ||
            currentUser.id === row.contract.room.property.landlordId,
        );
        if (loaded.outcome === 'EXPIRED') {
          return { outcome: 'EXPIRED' };
        }
        const { invitation } = loaded;

        await ResidentRepository.updateInvitationStatus(tx, invitation.id, {
          status: RESIDENT_INVITATION_STATUS.CANCELLED,
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
              cancelledById: currentUser.id,
            },
          },
        });

        await recordAuditLog(tx, {
          actorId: currentUser.id,
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
            cancelledById: currentUser.id,
          },
        });

        return {
          outcome: 'CANCELLED',
          data: {
            invitationId: invitation.id,
            contractId: invitation.contractId,
          },
        };
      },
    );

    if (result.outcome === 'EXPIRED') {
      throw new ApiError(409, 'INVITATION_EXPIRED', INVITATION_EXPIRED_MESSAGE);
    }

    return mapInvitationStatusActionResponse(
      result.data.invitationId,
      result.data.contractId,
      'CANCELLED',
    );
  }

  public static async removeResident(
    contractId: string,
    targetUserId: string,
    currentUser: CurrentUser,
  ): Promise<RemoveContractResidentDTO> {
    const context = await ResidentRepository.findContractAccessContext(contractId, currentUser.id);
    if (!context) {
      throw new ApiError(404, 'CONTRACT_NOT_FOUND', CONTRACT_NOT_FOUND_MESSAGE);
    }

    if (!context.isPrimaryTenant && !context.isLandlord && targetUserId !== currentUser.id) {
      throw new ApiError(403, 'FORBIDDEN', 'Bạn chỉ có thể tự rời khỏi danh sách cư trú của chính mình');
    }

    if (targetUserId === context.tenantId) {
      throw new ApiError(
        400,
        'CANNOT_REMOVE_PRIMARY_TENANT',
        'Không thể gỡ Chủ hợp đồng khỏi danh sách cư trú (BR-10)',
      );
    }

    const removalType: ResidentRemovalType =
      !context.isPrimaryTenant && !context.isLandlord
        ? 'SELF_LEAVE'
        : context.isLandlord
          ? 'REMOVED_BY_LANDLORD'
          : 'REMOVED_BY_PRIMARY_TENANT';

    const now = new Date();

    const result = await prisma.$transaction(
      async (tx): Promise<RemovedResidentTxResult> => {
        const locked = await ResidentRepository.lockContractRow(tx, contractId);
        if (!locked) {
          throw new ApiError(404, 'CONTRACT_NOT_FOUND', CONTRACT_NOT_FOUND_MESSAGE);
        }

        const contract = await ResidentRepository.findContractForMutation(tx, contractId);
        if (!contract) {
          throw new ApiError(404, 'CONTRACT_NOT_FOUND', CONTRACT_NOT_FOUND_MESSAGE);
        }

        if (targetUserId === contract.tenantId) {
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

        const resident = await ResidentRepository.findContractResident(tx, contract.id, targetUserId);
        if (!resident || resident.leftAt !== null) {
          throw new ApiError(
            404,
            'RESIDENT_NOT_FOUND',
            'Người dùng không phải là người ở cùng đang cư trú của hợp đồng này',
          );
        }

        await ResidentRepository.markResidentLeft(tx, contract.id, targetUserId, now);

        const activeCoResidentsAfter = await ResidentRepository.countActiveCoResidents(
          tx,
          contract.id,
        );
        const currentOccupants = 1 + activeCoResidentsAfter;
        const roomCode = contract.room.roomCode;
        const residentName = resident.user.fullName;
        const isSelfLeave = removalType === 'SELF_LEAVE';
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
            userId: targetUserId,
            removalType,
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

        if (!recipients.has(targetUserId)) {
          recipients.set(targetUserId, {
            recipientId: targetUserId,
            title,
            eventType: NOTIFICATION_EVENT_TYPE.RESIDENT_REMOVED,
            payload: buildPayload('/contracts'),
          });
        }

        await createNotificationsBatch(tx, Array.from(recipients.values()));

        await recordAuditLog(tx, {
          actorId: currentUser.id,
          entityType: 'CONTRACT_RESIDENT',
          entityId: contract.id,
          action: isSelfLeave ? 'RESIDENT_SELF_LEFT' : 'RESIDENT_REMOVED',
          oldData: {
            contractId: contract.id,
            userId: targetUserId,
            joinedAt: resident.joinedAt.toISOString(),
            leftAt: null,
          },
          newData: {
            contractId: contract.id,
            userId: targetUserId,
            joinedAt: resident.joinedAt.toISOString(),
            leftAt: now.toISOString(),
            removalType,
            currentOccupants,
          },
        });

        return {
          contractId: contract.id,
          userId: targetUserId,
          leftAt: now,
          removalType,
          currentOccupants,
          maxOccupants: contract.room.maxOccupants,
        };
      },
    );

    return mapRemoveResidentResponse(result);
  }
}
