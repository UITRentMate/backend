import { Prisma } from '@prisma/client';
import { NOTIFICATION_EVENT_TYPE, PHASE3_TIME_LIMITS_MS } from '../../common/constants/phase3-status';
import { ApiError } from '../../common/errors/api-error';
import { recordAuditLog } from '../../common/utils/audit-log.util';
import { createNotification, createNotificationsBatch } from '../../common/utils/notification.util';
import { mapToContract } from '../contracts/contract.mapper';
import { createDraftContract, findLiveContract, lockHoldRoom, withHoldTransaction } from '../contracts/contract.repository';
import { expireHoldForRoom } from '../contracts/contract.service';
import { RentalRequestRepository } from './rental-request.repository';
import {
  mapToRentalRequestCreated,
  mapToRentalRequestSummary,
  mapToRentalRequestDetail,
} from './rental-request.mapper';
import type {
  CreateRentalRequestInput,
  RejectRentalRequestInput,
  RentalRequestFilterQuery,
  RentalRequestCreatedResponse,
  PaginatedRentalRequestsResponse,
  RentalRequestDetailDTO,
  RejectRentalRequestResponse,
} from './rental-request.types';

async function withSerializableRetry<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await withHoldTransaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2034') || attempt === 2) {
        throw error;
      }
    }
  }
  throw new ApiError(409, 'DUPLICATE_RENTAL_REQUEST', 'Bạn đã có một yêu cầu thuê đang chờ duyệt cho phòng này');
}

function addMonths(start: Date, months: number): Date {
  const target = new Date(start);
  target.setUTCMonth(target.getUTCMonth() + months, 1);
  const lastDayOfTargetMonth = new Date(target);
  lastDayOfTargetMonth.setUTCMonth(target.getUTCMonth() + 1, 0);
  target.setUTCDate(Math.min(start.getUTCDate(), lastDayOfTargetMonth.getUTCDate()));
  return target;
}

export class RentalRequestService {
  public static async approveRentalRequest(landlordId: string, requestId: string) {
    const notFound = new ApiError(404, 'NOT_FOUND', 'Không tìm thấy yêu cầu thuê');
    const reference = await RentalRequestRepository.findRoomForApproval(requestId, landlordId);
    if (!reference) throw notFound;
    const { roomId } = reference;
    await expireHoldForRoom(roomId);

    const invalidStatus = new ApiError(409, 'INVALID_RENTAL_REQUEST_STATUS', 'Chỉ có thể duyệt yêu cầu thuê đang chờ');
    const unavailable = new ApiError(409, 'ROOM_ALREADY_HELD', 'Phòng không đủ điều kiện giữ chỗ');
    try {
      return await withHoldTransaction(async (tx) => {
        await lockHoldRoom(tx, roomId);
        const request = await RentalRequestRepository.findRequestForApproval(requestId, landlordId, tx);
        if (!request || request.roomId !== roomId) throw notFound;
        if (request.status !== 'PENDING') throw invalidStatus;
        const { room } = request;
        if (room.occupancyStatus !== 'VACANT' || room.isArchived || room.property.status !== 'ACTIVE'
          || await findLiveContract(tx, roomId)) throw unavailable;

        const now = new Date();
        const updated = await RentalRequestRepository.approvePendingRequest(tx, requestId, now);
        if (updated.count === 0) throw invalidStatus;
        const reason = 'Phòng đã được giữ chỗ cho một yêu cầu thuê khác';
        const rejected = await RentalRequestRepository.rejectCompetingRequests(tx, roomId, requestId, now, reason);
        await RentalRequestRepository.holdRoom(tx, roomId);
        const contract = await createDraftContract(tx, {
          roomId,
          tenantId: request.tenantId,
          rentalRequestId: requestId,
          startDate: request.desiredStartDate,
          endDate: addMonths(request.desiredStartDate, request.durationMonths ?? 6),
          rentSnapshot: room.monthlyRent,
          depositSnapshot: room.depositRequired,
          electricityRate: room.electricityRate,
          waterRate: room.waterRate,
          holdExpiresAt: new Date(now.getTime() + PHASE3_TIME_LIMITS_MS.CONTRACT_DRAFT_HOLD_MS),
          contractServiceFees: { create: room.serviceFees },
        });
        await createNotificationsBatch(tx, rejected.map(({ id, tenantId }) => ({
          recipientId: tenantId,
          title: 'Yêu cầu thuê phòng đã bị từ chối',
          eventType: NOTIFICATION_EVENT_TYPE.RENTAL_REQUEST_AUTO_REJECTED,
          payload: {
            content: reason,
            actionUrl: `/rental-requests/${id}`,
            relatedEntityType: 'RENTAL_REQUEST',
            relatedEntityId: id,
          },
        })));
        await createNotification(tx, {
          recipientId: request.tenantId,
          title: 'Yêu cầu thuê phòng đã được duyệt',
          eventType: NOTIFICATION_EVENT_TYPE.RENTAL_REQUEST_APPROVED,
          payload: {
            content: 'Chủ trọ đã duyệt yêu cầu thuê. Phòng được giữ chỗ trong 48 giờ.',
            actionUrl: `/contracts/${contract.id}`,
            relatedEntityType: 'CONTRACT',
            relatedEntityId: contract.id,
          },
        });
        await recordAuditLog(tx, {
          actorId: landlordId,
          entityType: 'RENTAL_REQUEST',
          entityId: requestId,
          action: NOTIFICATION_EVENT_TYPE.RENTAL_REQUEST_APPROVED,
          oldData: { status: 'PENDING' },
          newData: { status: 'APPROVED', roomId, contractId: contract.id, holdExpiresAt: contract.holdExpiresAt?.toISOString() },
        });
        return { rentalRequestId: requestId, status: 'APPROVED' as const, reviewedAt: now.toISOString(), contract: mapToContract(contract) };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw unavailable;
      }
      throw error;
    }
  }

  /**
   * RENT-01: Gửi yêu cầu thuê phòng công khai
   */
  public static async createRentalRequest(
    tenantId: string,
    input: CreateRentalRequestInput,
  ): Promise<RentalRequestCreatedResponse> {
    await expireHoldForRoom(input.roomId);
    try {
      const created = await withSerializableRetry(async (tx) => {
        await lockHoldRoom(tx, input.roomId);
        // 1. Kiểm tra phòng tồn tại và thỏa mãn 5 điều kiện hiển thị công khai
        const eligibleRoom = await RentalRequestRepository.findEligiblePublicRoom(input.roomId, tx);
        if (!eligibleRoom) {
          throw new ApiError(
            404,
            'ROOM_NOT_FOUND',
            'Phòng trọ không tồn tại hoặc không còn nhận yêu cầu thuê',
          );
        }

        // 2. Chặn duplicate PENDING request của cùng một người thuê cho cùng một phòng
        const existingPending = await RentalRequestRepository.findPendingByTenantAndRoom(
          tenantId,
          input.roomId,
          tx,
        );
        if (existingPending) {
          throw new ApiError(
            409,
            'DUPLICATE_RENTAL_REQUEST',
            'Bạn đã có một yêu cầu thuê đang chờ duyệt cho phòng này',
          );
        }

        // 3. Tạo yêu cầu thuê
        return await RentalRequestRepository.createRentalRequest(
          {
            roomId: input.roomId,
            tenantId,
            desiredStartDate: new Date(input.desiredMoveInDate),
            durationMonths: input.durationMonths ?? null,
            message: input.message ?? null,
          },
          tx,
        );
      });

      return mapToRentalRequestCreated(created);
    } catch (error) {
      // Xử lý race condition khi cả 2 transactions cùng vượt qua check và insert trùng partial unique constraint
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        throw new ApiError(
          409,
          'DUPLICATE_RENTAL_REQUEST',
          'Bạn đã có một yêu cầu thuê đang chờ duyệt cho phòng này',
        );
      }
      throw error;
    }
  }

  /**
   * RENT-02: Xem danh sách yêu cầu thuê theo phạm vi quyền (Tenant / Landlord)
   */
  public static async getRentalRequests(
    currentUser: { id: string; role: string },
    query: RentalRequestFilterQuery,
  ): Promise<PaginatedRentalRequestsResponse> {
    let result: { items: any[]; totalItems: number };

    if (currentUser.role === 'TENANT') {
      result = await RentalRequestRepository.findRequestsByTenant(currentUser.id, query);
    } else if (currentUser.role === 'LANDLORD') {
      result = await RentalRequestRepository.findRequestsByLandlord(currentUser.id, query);
    } else {
      throw new ApiError(403, 'FORBIDDEN', 'Bạn không có quyền thực hiện thao tác này');
    }

    return {
      items: result.items.map(mapToRentalRequestSummary),
      page: query.page,
      pageSize: query.pageSize,
      totalItems: result.totalItems,
      totalPages: Math.ceil(result.totalItems / query.pageSize) || 0,
    };
  }

  /**
   * RENT-03: Xem chi tiết yêu cầu thuê với phân quyền scoped
   */
  public static async getRentalRequestDetail(
    currentUser: { id: string; role: string },
    requestId: string,
  ): Promise<RentalRequestDetailDTO> {
    const detail = await RentalRequestRepository.findDetailById(requestId, currentUser);
    if (!detail) {
      throw new ApiError(
        404,
        'RENTAL_REQUEST_NOT_FOUND',
        'Yêu cầu thuê không tồn tại hoặc bạn không có quyền truy cập',
      );
    }

    await expireHoldForRoom(detail.roomId);
    return mapToRentalRequestDetail(detail);
  }

  /**
   * RENT-05: Chủ trọ từ chối yêu cầu thuê PENDING kèm lý do
   */
  public static async rejectRentalRequest(
    landlordId: string,
    requestId: string,
    input: RejectRentalRequestInput,
  ): Promise<RejectRentalRequestResponse> {
    const result = await RentalRequestRepository.rejectPendingRequest(
      requestId,
      landlordId,
      input.reason,
    );

    if (result.count === 0) {
      // Kiểm tra nguyên nhân cập nhật thất bại
      const existing = await RentalRequestRepository.findLandlordRentalRequestById(
        requestId,
        landlordId,
      );

      if (!existing) {
        throw new ApiError(
          404,
          'RENTAL_REQUEST_NOT_FOUND',
          'Yêu cầu thuê không tồn tại hoặc bạn không có quyền truy cập',
        );
      }

      // Đã tồn tại nhưng trạng thái không phải PENDING (ví dụ đã REJECTED hoặc trạng thái khác)
      throw new ApiError(
        409,
        'INVALID_STATUS_TRANSITION',
        `Không thể từ chối yêu cầu thuê ở trạng thái ${existing.status}`,
      );
    }

    return {
      rentalRequestId: requestId,
      status: 'REJECTED',
      rejectionReason: input.reason,
      reviewedAt: result.reviewedAt.toISOString(),
    };
  }
}
