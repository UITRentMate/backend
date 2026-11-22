import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { ApiError } from '../../common/errors/api-error';
import { NOTIFICATION_EVENT_TYPE } from '../../common/constants/phase3-status';
import { createNotification } from '../../common/utils/notification.util';
import {
  DEFAULT_VIEWING_DURATION_MINUTES,
  VIEWING_STATUS,
  type CreateViewingAppointmentInput,
  type ViewingAppointmentListQuery,
} from './viewing-appointment.types';

export interface CreateAppointmentNotificationMeta {
  landlordId: string;
  roomCode?: string | null;
  propertyName?: string | null;
}

export interface RejectAppointmentNotificationMeta {
  tenantId: string;
  roomCode?: string | null;
  propertyName?: string | null;
}

export interface CancelAppointmentNotificationMeta {
  recipientId: string;
  roomCode?: string | null;
  propertyName?: string | null;
  canceledByRole?: 'TENANT' | 'LANDLORD';
}

function formatRoomLabel(roomCode?: string | null, propertyName?: string | null): string {
  if (roomCode && propertyName) {
    return `phòng ${roomCode} (${propertyName})`;
  }
  if (roomCode) {
    return `phòng ${roomCode}`;
  }
  return 'phòng trọ';
}

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
        roomCode: true,
        property: {
          select: {
            id: true,
            name: true,
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
    notificationMeta?: CreateAppointmentNotificationMeta,
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

      if (notificationMeta?.landlordId) {
        const roomLabel = formatRoomLabel(notificationMeta.roomCode, notificationMeta.propertyName);
        await createNotification(tx, {
          recipientId: notificationMeta.landlordId,
          title: 'Có lịch hẹn xem phòng mới',
          eventType: NOTIFICATION_EVENT_TYPE.VIEWING_APPOINTMENT_CREATED,
          payload: {
            content: `Người thuê vừa đặt lịch hẹn xem ${roomLabel}.`,
            actionUrl: `/landlord/viewing-appointments/${appointment.id}`,
            relatedEntityType: 'VIEWING_APPOINTMENT',
            relatedEntityId: appointment.id,
          },
        });
      }

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
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
    try {
      return await prisma.$transaction(
        async (tx) => {
          const appointment = await tx.viewingAppointment.findUnique({
            where: { id: appointmentId },
            include: {
              timeOptions: true,
              room: {
                select: {
                  roomCode: true,
                  property: { select: { name: true } },
                },
              },
            },
          });

          if (!appointment) {
            throw new ApiError(404, 'APPOINTMENT_NOT_FOUND', 'Lịch hẹn không tồn tại hoặc bạn không có quyền truy cập');
          }
          if (appointment.status !== VIEWING_STATUS.PENDING) {
            throw new ApiError(409, 'CONFLICT', `Không thể xác nhận lịch hẹn ở trạng thái ${appointment.status}`);
          }

          const chosenSlot = appointment.timeOptions.find((slot) => slot.id === selectedSlotId);
          if (!chosenSlot) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'Khung giờ được chọn không thuộc danh sách đề xuất của lịch hẹn này', {
              selectedSlotId: ['Mã khung giờ không thuộc lịch hẹn này'],
            });
          }

          const slotStart = chosenSlot.startAt;
          const durationMs = DEFAULT_VIEWING_DURATION_MINUTES * 60 * 1000;
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
            include: { selectedSlot: true },
          });

          if (conflictingAppointment) {
            throw new ApiError(
              409,
              'SLOT_CONFLICT',
              'Khung giờ này đã bị trùng với một lịch hẹn khác đã xác nhận cho phòng này',
            );
          }

          await tx.viewingTimeOption.update({
            where: { id: selectedSlotId },
            data: { isSelected: true },
          });

          const updated = await tx.viewingAppointment.update({
            where: { id: appointmentId },
            data: { status: VIEWING_STATUS.CONFIRMED, selectedSlotId },
            include: {
              selectedSlot: { select: { id: true, startAt: true } },
            },
          });

          const roomLabel = formatRoomLabel(
            appointment.room?.roomCode,
            appointment.room?.property?.name,
          );
          await createNotification(tx, {
            recipientId: appointment.tenantId,
            title: 'Lịch hẹn xem phòng đã được xác nhận',
            eventType: NOTIFICATION_EVENT_TYPE.VIEWING_APPOINTMENT_CONFIRMED,
            payload: {
              content: `Chủ trọ đã xác nhận lịch hẹn xem ${roomLabel}.`,
              actionUrl: `/viewing-appointments/${appointmentId}`,
              relatedEntityType: 'VIEWING_APPOINTMENT',
              relatedEntityId: appointmentId,
              metadata: {
                selectedSlotId,
                startAt: chosenSlot.startAt.toISOString(),
              },
            },
          });

          return updated;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2034') {
        const current = await prisma.viewingAppointment.findUnique({
          where: { id: appointmentId },
          select: { status: true },
        });
        if (current && current.status !== VIEWING_STATUS.PENDING) {
          throw new ApiError(409, 'CONFLICT', 'Lịch hẹn đã được xử lý bởi một yêu cầu đồng thời khác');
        }
        throw new ApiError(
          409,
          'SLOT_CONFLICT',
          'Khung giờ này vừa được xác nhận cho một lịch hẹn khác của phòng',
        );
      }
      throw error;
    }
  }

  /**
   * Cập nhật trạng thái từ chối lịch hẹn kèm thông báo nguyên tử
   */
  public static async rejectAppointment(
    appointmentId: string,
    reason: string,
    notificationMeta?: RejectAppointmentNotificationMeta,
  ) {
    return prisma.$transaction(async (tx) => {
      const result = await tx.viewingAppointment.updateMany({
        where: { id: appointmentId, status: VIEWING_STATUS.PENDING },
        data: {
          status: VIEWING_STATUS.REJECTED,
          rejectionReason: reason,
        },
      });

      if (result.count === 0) {
        throw new ApiError(409, 'CONFLICT', 'Lịch hẹn không còn ở trạng thái PENDING để từ chối');
      }

      if (notificationMeta?.tenantId) {
        const roomLabel = formatRoomLabel(notificationMeta.roomCode, notificationMeta.propertyName);
        await createNotification(tx, {
          recipientId: notificationMeta.tenantId,
          title: 'Lịch hẹn xem phòng bị từ chối',
          eventType: NOTIFICATION_EVENT_TYPE.VIEWING_APPOINTMENT_REJECTED,
          payload: {
            content: `Chủ trọ đã từ chối lịch hẹn xem ${roomLabel}. Lý do: ${reason}`,
            actionUrl: `/viewing-appointments/${appointmentId}`,
            relatedEntityType: 'VIEWING_APPOINTMENT',
            relatedEntityId: appointmentId,
          },
        });
      }

      return { id: appointmentId };
    });
  }

  /**
   * Cập nhật trạng thái hủy lịch hẹn nếu trạng thái vẫn khớp với lần kiểm tra của service kèm thông báo nguyên tử
   */
  public static async cancelAppointment(
    appointmentId: string,
    reason: string,
    expectedStatus: typeof VIEWING_STATUS.PENDING | typeof VIEWING_STATUS.CONFIRMED,
    notificationMeta?: CancelAppointmentNotificationMeta,
  ) {
    return prisma.$transaction(async (tx) => {
      const result = await tx.viewingAppointment.updateMany({
        where: { id: appointmentId, status: expectedStatus },
        data: {
          status: VIEWING_STATUS.CANCELLED,
          cancellationReason: reason,
        },
      });

      if (result.count === 0) {
        throw new ApiError(409, 'CONFLICT', 'Lịch hẹn đã được xử lý bởi một yêu cầu đồng thời khác');
      }

      if (notificationMeta?.recipientId) {
        const roomLabel = formatRoomLabel(notificationMeta.roomCode, notificationMeta.propertyName);
        const actorLabel =
          notificationMeta.canceledByRole === 'TENANT' ? 'Người thuê' : 'Chủ trọ';
        const actionUrl =
          notificationMeta.canceledByRole === 'TENANT'
            ? `/landlord/viewing-appointments/${appointmentId}`
            : `/viewing-appointments/${appointmentId}`;

        await createNotification(tx, {
          recipientId: notificationMeta.recipientId,
          title: 'Lịch hẹn xem phòng đã bị hủy',
          eventType: NOTIFICATION_EVENT_TYPE.VIEWING_APPOINTMENT_CANCELLED,
          payload: {
            content: `${actorLabel} đã hủy lịch hẹn xem ${roomLabel}. Lý do: ${reason}`,
            actionUrl,
            relatedEntityType: 'VIEWING_APPOINTMENT',
            relatedEntityId: appointmentId,
          },
        });
      }

      return { id: appointmentId };
    });
  }
}
