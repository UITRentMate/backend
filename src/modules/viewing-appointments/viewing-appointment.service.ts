import { prisma } from '../../infrastructure/database/prisma';
import { ApiError } from '../../common/errors/api-error';
import { ViewingAppointmentRepository } from './viewing-appointment.repository';
import {
  mapToViewingAppointmentItemDTO,
  mapToViewingAppointmentDetailDTO,
  mapToViewingSlotDTO,
} from './viewing-appointment.mapper';
import {
  VIEWING_STATUS,
  type CreateViewingAppointmentInput,
  type ConfirmViewingAppointmentInput,
  type RejectViewingAppointmentInput,
  type CancelViewingAppointmentInput,
  type ViewingAppointmentListQuery,
  type CreateViewingAppointmentResponseDTO,
  type ConfirmViewingAppointmentResponseDTO,
  type RejectViewingAppointmentResponseDTO,
  type CancelViewingAppointmentResponseDTO,
  type PaginatedViewingAppointmentsDTO,
  type ViewingAppointmentDetailDTO,
} from './viewing-appointment.types';

export class ViewingAppointmentService {
  /**
   * Tạo lịch hẹn xem phòng mới (VIEW-01)
   */
  public static async createAppointment(
    tenantId: string,
    input: CreateViewingAppointmentInput,
  ): Promise<CreateViewingAppointmentResponseDTO> {
    // Lấy thông tin user để dự phòng contactPhone nếu client không truyền
    const tenantUser = await prisma.user.findUnique({
      where: { id: tenantId },
      select: { id: true, phone: true },
    });

    if (!tenantUser) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Tài khoản không tồn tại hoặc phiên đăng nhập không hợp lệ');
    }

    const contactPhone = input.contactPhone ?? tenantUser.phone;
    if (!contactPhone) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Cần cung cấp số điện thoại liên hệ hợp lệ', {
        contactPhone: ['Số điện thoại liên hệ là bắt buộc'],
      });
    }

    // Kiểm tra điều kiện công khai của phòng trọ
    const room = await ViewingAppointmentRepository.validateRoomPublicEligibility(input.roomId);
    if (!room) {
      throw new ApiError(
        404,
        'ROOM_NOT_FOUND',
        'Phòng trọ không tồn tại hoặc không khả dụng để đặt lịch xem phòng',
      );
    }

    // Không cho phép chủ trọ tự đặt lịch xem phòng của chính mình
    if (room.property.landlordId === tenantId) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'Chủ trọ không thể tự đặt lịch xem phòng của chính mình',
        { roomId: ['Bạn không thể đặt lịch xem phòng thuộc sở hữu của mình'] },
      );
    }

    // Kiểm tra lịch PENDING trùng lặp của cùng người thuê và phòng
    const hasPending = await ViewingAppointmentRepository.hasPendingAppointmentForRoom(
      input.roomId,
      tenantId,
    );
    if (hasPending) {
      throw new ApiError(
        409,
        'DUPLICATE_APPOINTMENT',
        'Bạn đã có một lịch hẹn xem phòng đang chờ xử lý cho phòng trọ này',
      );
    }

    // Tạo lịch và các slot đề xuất trong một transaction
    const appointment = await ViewingAppointmentRepository.createAppointmentWithSlots(
      tenantId,
      contactPhone,
      input,
    );

    return {
      appointmentId: appointment.id,
      status: appointment.status,
    };
  }

  /**
   * Lấy danh sách lịch hẹn theo phân quyền người thuê / chủ trọ (VIEW-02)
   */
  public static async getAppointmentList(
    user: { id: string; role: string },
    query: ViewingAppointmentListQuery,
  ): Promise<PaginatedViewingAppointmentsDTO> {
    const { items, total } = await ViewingAppointmentRepository.findAppointmentsList(user, query);

    const mappedItems = items.map(mapToViewingAppointmentItemDTO);
    const totalPages = Math.ceil(total / query.pageSize) || (total === 0 ? 0 : 1);

    return {
      items: mappedItems,
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages,
    };
  }

  /**
   * Xem chi tiết một lịch hẹn xem phòng (VIEW-03)
   */
  public static async getAppointmentDetail(
    user: { id: string; role: string },
    appointmentId: string,
  ): Promise<ViewingAppointmentDetailDTO> {
    const appointment = await ViewingAppointmentRepository.findAppointmentById(appointmentId);

    if (!appointment) {
      throw new ApiError(
        404,
        'APPOINTMENT_NOT_FOUND',
        'Lịch hẹn không tồn tại hoặc bạn không có quyền truy cập',
      );
    }

    // Kiểm tra phân quyền truy cập:
    // Chủ trọ chỉ xem lịch thuộc phòng do mình sở hữu
    // Người thuê chỉ xem lịch do mình tạo
    const isLandlordOwner =
      user.role === 'LANDLORD' && appointment.room?.property?.landlordId === user.id;
    const isTenantOwner = appointment.tenantId === user.id;

    if (!isLandlordOwner && !isTenantOwner) {
      throw new ApiError(
        404,
        'APPOINTMENT_NOT_FOUND',
        'Lịch hẹn không tồn tại hoặc bạn không có quyền truy cập',
      );
    }

    return mapToViewingAppointmentDetailDTO(appointment);
  }

  /**
   * Chủ trọ xác nhận lịch hẹn xem phòng (VIEW-04)
   */
  public static async confirmAppointment(
    landlordId: string,
    appointmentId: string,
    input: ConfirmViewingAppointmentInput,
  ): Promise<ConfirmViewingAppointmentResponseDTO> {
    const appointment = await ViewingAppointmentRepository.findAppointmentById(appointmentId);

    if (!appointment || appointment.room?.property?.landlordId !== landlordId) {
      throw new ApiError(
        404,
        'APPOINTMENT_NOT_FOUND',
        'Lịch hẹn không tồn tại hoặc bạn không có quyền truy cập',
      );
    }

    if (appointment.status === VIEWING_STATUS.CONFIRMED) {
      throw new ApiError(409, 'CONFLICT', 'Lịch hẹn đã được xác nhận trước đó');
    }

    if (appointment.status === VIEWING_STATUS.REJECTED) {
      throw new ApiError(409, 'CONFLICT', 'Không thể xác nhận lịch hẹn đã bị từ chối');
    }

    if (appointment.status === VIEWING_STATUS.CANCELLED) {
      throw new ApiError(409, 'CONFLICT', 'Không thể xác nhận lịch hẹn đã bị hủy');
    }

    if (appointment.status !== VIEWING_STATUS.PENDING) {
      throw new ApiError(
        409,
        'CONFLICT',
        `Chỉ có thể xác nhận lịch hẹn đang ở trạng thái PENDING`,
      );
    }

    const slotExists = appointment.timeOptions.some((s) => s.id === input.selectedSlotId);
    if (!slotExists) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'Khung giờ được chọn không thuộc danh sách đề xuất của lịch hẹn này',
        { selectedSlotId: ['Mã khung giờ không thuộc lịch hẹn này'] },
      );
    }

    // Thực hiện xác nhận an toàn chống double-booking trong transaction
    const updated = await ViewingAppointmentRepository.confirmAppointmentInTx(
      appointmentId,
      input.selectedSlotId,
    );

    return {
      appointmentId: updated.id,
      status: VIEWING_STATUS.CONFIRMED,
      selectedSlot: mapToViewingSlotDTO(updated.selectedSlot!),
    };
  }

  /**
   * Chủ trọ từ chối lịch hẹn xem phòng (VIEW-06)
   */
  public static async rejectAppointment(
    landlordId: string,
    appointmentId: string,
    input: RejectViewingAppointmentInput,
  ): Promise<RejectViewingAppointmentResponseDTO> {
    const appointment = await ViewingAppointmentRepository.findAppointmentById(appointmentId);

    if (!appointment || appointment.room?.property?.landlordId !== landlordId) {
      throw new ApiError(
        404,
        'APPOINTMENT_NOT_FOUND',
        'Lịch hẹn không tồn tại hoặc bạn không có quyền truy cập',
      );
    }

    if (appointment.status === VIEWING_STATUS.CONFIRMED) {
      throw new ApiError(409, 'CONFLICT', 'Không thể từ chối lịch hẹn đã được xác nhận');
    }

    if (appointment.status === VIEWING_STATUS.REJECTED) {
      throw new ApiError(409, 'CONFLICT', 'Lịch hẹn đã bị từ chối trước đó');
    }

    if (appointment.status === VIEWING_STATUS.CANCELLED) {
      throw new ApiError(409, 'CONFLICT', 'Không thể từ chối lịch hẹn đã bị hủy');
    }

    if (appointment.status !== VIEWING_STATUS.PENDING) {
      throw new ApiError(
        409,
        'CONFLICT',
        `Chỉ có thể từ chối lịch hẹn đang ở trạng thái PENDING`,
      );
    }

    const updated = await ViewingAppointmentRepository.rejectAppointment(
      appointmentId,
      input.reason,
    );

    return {
      appointmentId: updated.id,
      status: VIEWING_STATUS.REJECTED,
      rejectionReason: input.reason,
    };
  }

  /**
   * Người thuê hoặc Chủ trọ hủy lịch hẹn xem phòng (VIEW-07)
   */
  public static async cancelAppointment(
    user: { id: string; role: string },
    appointmentId: string,
    input: CancelViewingAppointmentInput,
  ): Promise<CancelViewingAppointmentResponseDTO> {
    const appointment = await ViewingAppointmentRepository.findAppointmentById(appointmentId);

    if (!appointment) {
      throw new ApiError(
        404,
        'APPOINTMENT_NOT_FOUND',
        'Lịch hẹn không tồn tại hoặc bạn không có quyền truy cập',
      );
    }

    // Kiểm tra quyền hủy:
    // Người thuê chỉ được hủy lịch của mình
    // Chủ trọ chỉ được hủy lịch thuộc phòng do mình sở hữu
    const isLandlordOwner =
      user.role === 'LANDLORD' && appointment.room?.property?.landlordId === user.id;
    const isTenantOwner = appointment.tenantId === user.id;

    if (!isLandlordOwner && !isTenantOwner) {
      throw new ApiError(
        404,
        'APPOINTMENT_NOT_FOUND',
        'Lịch hẹn không tồn tại hoặc bạn không có quyền truy cập',
      );
    }

    // Kiểm tra trạng thái cuối không thể thay đổi
    if (appointment.status === VIEWING_STATUS.CANCELLED) {
      throw new ApiError(409, 'CONFLICT', 'Lịch hẹn đã bị hủy trước đó');
    }

    if (appointment.status === VIEWING_STATUS.REJECTED) {
      throw new ApiError(409, 'CONFLICT', 'Không thể hủy lịch hẹn đã bị từ chối');
    }

    // Kiểm tra cutoff time đối với CONFIRMED
    if (appointment.status === VIEWING_STATUS.CONFIRMED) {
      if (!appointment.selectedSlot) {
        throw new ApiError(409, 'CONFLICT', 'Lịch hẹn không có khung giờ đã chọn');
      }

      const slotStart = new Date(appointment.selectedSlot.startAt).getTime();
      const now = Date.now();
      if (slotStart <= now) {
        throw new ApiError(
          409,
          'CANCELLATION_CUTOFF_EXCEEDED',
          'Không thể hủy lịch hẹn đã xác nhận khi đã đến hoặc qua giờ hẹn',
        );
      }
    } else if (appointment.status !== VIEWING_STATUS.PENDING) {
      throw new ApiError(
        409,
        'CONFLICT',
        `Không thể hủy lịch hẹn ở trạng thái ${appointment.status}`,
      );
    }

    const updated = await ViewingAppointmentRepository.cancelAppointment(
      appointmentId,
      input.reason,
    );

    return {
      appointmentId: updated.id,
      status: VIEWING_STATUS.CANCELLED,
      cancellationReason: input.reason,
    };
  }
}
