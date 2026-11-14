import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { ApiError } from '../../common/errors/api-error';
import {
  DEFAULT_VIEWING_DURATION_MINUTES,
  VIEWING_STATUS,
  type CreateViewingAppointmentInput,
  type ViewingAppointmentListQuery,
} from './viewing-appointment.types';

export class ViewingAppointmentRepository {
  /**
   * Kiểm tra điều kiện công khai của phòng trọ:
   * 1. Room.occupancyStatus = 'VACANT'
   * 2. Room.visibilityStatus = 'VISIBLE'
   * 3. Room.isArchived = false
   * 4. Property.status = 'ACTIVE'
   * 5. Property.landlord.accountStatus = 'ACTIVE'
   */
  public static async validateRoomPublicEligibility(roomId: string) {
    return prisma.room.findFirst({
      where: {
        id: roomId,
        occupancyStatus: 'VACANT',
        visibilityStatus: 'VISIBLE',
        isArchived: false,
        property: {
          status: 'ACTIVE',
          landlord: {
            accountStatus: 'ACTIVE',
          },
        },
      },
      select: {
        id: true,
        property: {
          select: {
            id: true,
            landlordId: true,
          },
        },
      },
    });
  }

  /**
   * Kiểm tra người thuê đã có lịch hẹn PENDING cho phòng này hay chưa
   */
  public static async hasPendingAppointmentForRoom(roomId: string, tenantId: string): Promise<boolean> {
    const count = await prisma.viewingAppointment.count({
      where: {
        roomId,
        tenantId,
        status: VIEWING_STATUS.PENDING,
      },
    });
    return count > 0;
  }

  /**
   * Tạo ViewingAppointment cùng các ViewingTimeOption trong một transaction
   */
  public static async createAppointmentWithSlots(
    tenantId: string,
    contactPhone: string,
    input: CreateViewingAppointmentInput,
  ) {
    return prisma.$transaction(async (tx) => {
      const appointment = await tx.viewingAppointment.create({
        data: {
          roomId: input.roomId,
          tenantId,
          contactPhone,
          status: VIEWING_STATUS.PENDING,
          note: input.note ?? null,
        },
      });

      const slotCreatePromises = input.proposedSlots.map((slotStr) =>
        tx.viewingTimeOption.create({
          data: {
            appointmentId: appointment.id,
            proposedBy: tenantId,
            startAt: new Date(slotStr),
            isSelected: false,
          },
        }),
      );

      await Promise.all(slotCreatePromises);

      return appointment;
    });
  }

  /**
   * Tìm chi tiết lịch hẹn theo ID kèm các quan hệ
   */
  public static async findAppointmentById(appointmentId: string) {
    return prisma.viewingAppointment.findUnique({
      where: { id: appointmentId },
      include: {
        room: {
          select: {
            id: true,
            roomCode: true,
            property: {
              select: {
                id: true,
                name: true,
                address: true,
                landlordId: true,
              },
            },
          },
        },
        tenant: {
          select: {
            id: true,
            fullName: true,
          },
        },
        timeOptions: {
          select: {
            id: true,
            startAt: true,
            isSelected: true,
          },
          orderBy: {
            startAt: 'asc',
          },
        },
        selectedSlot: {
          select: {
            id: true,
            startAt: true,
          },
        },
      },
    });
  }

  /**
   * Lấy danh sách lịch hẹn phân trang theo quyền và bộ lọc
   */
  public static async findAppointmentsList(
    user: { id: string; role: string },
    query: ViewingAppointmentListQuery,
  ) {
    const where: Prisma.ViewingAppointmentWhereInput = {};

    // Phân quyền theo vai trò
    if (user.role === 'LANDLORD') {
      where.room = {
        property: {
          landlordId: user.id,
        },
      };
    } else {
      where.tenantId = user.id;
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.roomId) {
      where.roomId = query.roomId;
    }

    if (query.fromDate || query.toDate) {
      where.createdAt = {};
      if (query.fromDate) {
        where.createdAt.gte = query.fromDate;
      }
      if (query.toDate) {
        where.createdAt.lte = query.toDate;
      }
    }

    const skip = (query.page - 1) * query.pageSize;
    const take = query.pageSize;

    const [items, total] = await Promise.all([
      prisma.viewingAppointment.findMany({
        where,
        skip,
        take,
        orderBy: {
          createdAt: 'desc',
        },
        include: {
          timeOptions: {
            select: {
              id: true,
              startAt: true,
            },
            orderBy: {
              startAt: 'asc',
            },
          },
          selectedSlot: {
            select: {
              id: true,
              startAt: true,
            },
          },
        },
      }),
      prisma.viewingAppointment.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Xác nhận lịch hẹn bên trong transaction:
   * - Kiểm tra trạng thái hiện tại (phải là PENDING)
   * - Kiểm tra selectedSlotId thuộc đúng appointment
   * - Kiểm tra xung đột với các lịch hẹn CONFIRMED khác cùng phòng
   * - Cập nhật isSelected = true và status = CONFIRMED
   */
  public static async confirmAppointmentInTx(
    appointmentId: string,
    selectedSlotId: string,
  ) {
    return prisma.$transaction(async (tx) => {
      const appointment = await tx.viewingAppointment.findUnique({
        where: { id: appointmentId },
        include: {
          timeOptions: true,
        },
      });

      if (!appointment) {
        throw new ApiError(404, 'APPOINTMENT_NOT_FOUND', 'Lịch hẹn không tồn tại hoặc bạn không có quyền truy cập');
      }

      if (appointment.status !== VIEWING_STATUS.PENDING) {
        throw new ApiError(
          409,
          'CONFLICT',
          `Không thể xác nhận lịch hẹn ở trạng thái ${appointment.status}`,
        );
      }

      const chosenSlot = appointment.timeOptions.find((slot) => slot.id === selectedSlotId);
      if (!chosenSlot) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Khung giờ được chọn không thuộc danh sách đề xuất của lịch hẹn này', {
          selectedSlotId: ['Mã khung giờ không thuộc lịch hẹn này'],
        });
      }

      const slotStart = chosenSlot.startAt;
      const durationMs = DEFAULT_VIEWING_DURATION_MINUTES * 60 * 1000;

      // Kiểm tra xung đột với bất kỳ lịch hẹn CONFIRMED nào khác của cùng phòng
      const conflictingAppointment = await tx.viewingAppointment.findFirst({
        where: {
          id: { not: appointmentId },
          roomId: appointment.roomId,
          status: VIEWING_STATUS.CONFIRMED,
          selectedSlot: {
            startAt: {
              gt: new Date(slotStart.getTime() - durationMs),
              lt: new Date(slotStart.getTime() + durationMs),
            },
          },
        },
        include: {
          selectedSlot: true,
        },
      });

      if (conflictingAppointment) {
        throw new ApiError(
          409,
          'SLOT_CONFLICT',
          'Khung giờ này đã bị trùng với một lịch hẹn khác đã xác nhận cho phòng này',
        );
      }

      // Đánh dấu slot được chọn
      await tx.viewingTimeOption.update({
        where: { id: selectedSlotId },
        data: { isSelected: true },
      });

      // Cập nhật trạng thái lịch hẹn
      const updated = await tx.viewingAppointment.update({
        where: { id: appointmentId },
        data: {
          status: VIEWING_STATUS.CONFIRMED,
          selectedSlotId,
        },
        include: {
          selectedSlot: {
            select: {
              id: true,
              startAt: true,
            },
          },
        },
      });

      return updated;
    });
  }

  /**
   * Cập nhật trạng thái từ chối lịch hẹn
   */
  public static async rejectAppointment(appointmentId: string, reason: string) {
    return prisma.viewingAppointment.update({
      where: { id: appointmentId },
      data: {
        status: VIEWING_STATUS.REJECTED,
        rejectionReason: reason,
      },
    });
  }

  /**
   * Cập nhật trạng thái hủy lịch hẹn
   */
  public static async cancelAppointment(appointmentId: string, reason: string) {
    return prisma.viewingAppointment.update({
      where: { id: appointmentId },
      data: {
        status: VIEWING_STATUS.CANCELLED,
        cancellationReason: reason,
      },
    });
  }
}
