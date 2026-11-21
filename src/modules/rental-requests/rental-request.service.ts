import { Prisma } from '@prisma/client';
import { ApiError } from '../../common/errors/api-error';
import { prisma } from '../../infrastructure/database/prisma';
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
      return await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2034') || attempt === 2) {
        throw error;
      }
    }
  }
  throw new ApiError(409, 'DUPLICATE_RENTAL_REQUEST', 'Bạn đã có một yêu cầu thuê đang chờ duyệt cho phòng này');
}

export class RentalRequestService {
  /**
   * RENT-01: Gửi yêu cầu thuê phòng công khai
   */
  public static async createRentalRequest(
    tenantId: string,
    input: CreateRentalRequestInput,
  ): Promise<RentalRequestCreatedResponse> {
    try {
      const created = await withSerializableRetry(async (tx) => {
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

    return mapToRentalRequestDetail(detail as any);
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
