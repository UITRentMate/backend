import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser } from '../../common/middleware/require-role';
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
  AcceptResidentInvitationDTO,
  ContractResidentsResponseDTO,
  InvitationStatusActionDTO,
  PaginatedResidentInvitationsDTO,
  ParsedInviteIdentifier,
  RemoveContractResidentDTO,
  ResidentInvitationCreatedDTO,
  ResidentInvitationListQuery,
  ResidentRemovalType,
} from './resident.types';

const CONTRACT_NOT_FOUND_MESSAGE = 'Hợp đồng không tồn tại hoặc bạn không có quyền truy cập';
const INVITATION_NOT_FOUND_MESSAGE = 'Lời mời ở cùng không tồn tại hoặc bạn không có quyền truy cập';
const INVITATION_EXPIRED_MESSAGE = 'Lời mời ở cùng đã hết hạn sau 72 giờ';

export class ResidentService {
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

    const created = await ResidentRepository.createInvitationInTx({
      contractId,
      identifier,
      invitedById: currentUser.id,
    });

    return mapCreatedInvitationResponse(created);
  }

  public static async listMyInvitations(
    query: ResidentInvitationListQuery,
    currentUser: CurrentUser,
  ): Promise<PaginatedResidentInvitationsDTO> {
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

    const result = await ResidentRepository.acceptInvitationInTx({
      invitationId,
      actorId: currentUser.id,
    });

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

    const result = await ResidentRepository.rejectInvitationInTx({
      invitationId,
      actorId: currentUser.id,
    });

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

    const result = await ResidentRepository.cancelInvitationInTx({
      invitationId,
      actorId: currentUser.id,
    });

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

    const result = await ResidentRepository.removeResidentInTx({
      contractId,
      targetUserId,
      actorId: currentUser.id,
      removalType,
    });

    return mapRemoveResidentResponse(result);
  }
}
