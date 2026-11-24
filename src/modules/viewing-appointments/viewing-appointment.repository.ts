import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import {
  VIEWING_STATUS,
  type CreateViewingAppointmentInput,
  type ViewingAppointmentListQuery,
} from './viewing-appointment.types';

export type ViewingAppointmentDbClient = Prisma.TransactionClient | typeof prisma;

export class ViewingAppointmentRepository {
  /**
   * Kiểm tra điều kiện công khai của phòng trọ:
   * 1. Room.occupancyStatus = 'VACANT'
   * 2. Room.visibilityStatus = 'VISIBLE'
   * 3. Room.isArchived = false
   * 4. Property.status = 'ACTIVE'
   * 5. Property.landlord.accountStatus = 'ACTIVE'
   */
  public static async validateRoomPublicEligibility(
    roomId: string,
    client: ViewingAppointmentDbClient = prisma,
  ) {
    return client.room.findFirst({
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
  public static async hasPendingAppointmentForRoom(
    roomId: string,
    tenantId: string,
    client: ViewingAppointmentDbClient = prisma,
  ): Promise<boolean> {
    const count = await client.viewingAppointment.count({
      where: {
        roomId,
        tenantId,
        status: VIEWING_STATUS.PENDING,
      },
    });
    return count > 0;
  }

  /**
   * Tạo ViewingAppointment cùng các ViewingTimeOption trong transaction (bắt buộc truyền tx)
   */
  public static async createAppointmentWithSlots(
    tenantId: string,
    contactPhone: string,
    input: CreateViewingAppointmentInput,
    tx: Prisma.TransactionClient,
  ) {
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
  }

  /**
   * Tìm chi tiết lịch hẹn theo ID kèm các quan hệ
   */
  public static async findAppointmentById(
    appointmentId: string,
    client: ViewingAppointmentDbClient = prisma,
  ) {
    return client.viewingAppointment.findUnique({
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
   * Tìm trạng thái hiện tại của lịch hẹn theo ID
   */
  public static async findAppointmentStatusById(
    appointmentId: string,
    client: ViewingAppointmentDbClient = prisma,
  ) {
    return client.viewingAppointment.findUnique({
      where: { id: appointmentId },
      select: { status: true },
    });
  }

  /**
   * Lấy danh sách lịch hẹn phân trang theo quyền và bộ lọc
   */
  public static async findAppointmentsList(
    user: { id: string; role: string },
    query: ViewingAppointmentListQuery,
    client: ViewingAppointmentDbClient = prisma,
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
      client.viewingAppointment.findMany({
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
      client.viewingAppointment.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Tìm lịch hẹn đã CONFIRMED bị trùng khung giờ của cùng phòng
   */
  public static async findConflictingConfirmedAppointment(
    appointmentId: string,
    roomId: string,
    windowStart: Date,
    windowEnd: Date,
    client: ViewingAppointmentDbClient = prisma,
  ) {
    return client.viewingAppointment.findFirst({
      where: {
        id: { not: appointmentId },
        roomId,
        status: VIEWING_STATUS.CONFIRMED,
        selectedSlot: {
          startAt: {
            gt: windowStart,
            lt: windowEnd,
          },
        },
      },
      include: { selectedSlot: true },
    });
  }

  /**
   * Đánh dấu slot được chọn và chuyển lịch hẹn sang trạng thái CONFIRMED trong transaction (bắt buộc truyền tx)
   */
  public static async confirmAppointmentSelection(
    appointmentId: string,
    selectedSlotId: string,
    tx: Prisma.TransactionClient,
  ) {
    await tx.viewingTimeOption.update({
      where: { id: selectedSlotId },
      data: { isSelected: true },
    });

    return tx.viewingAppointment.update({
      where: { id: appointmentId },
      data: { status: VIEWING_STATUS.CONFIRMED, selectedSlotId },
      include: {
        selectedSlot: { select: { id: true, startAt: true } },
      },
    });
  }

  /**
   * Atomic conditional update: chuyển trạng thái PENDING -> REJECTED kèm lý do
   */
  public static async rejectAppointment(
    appointmentId: string,
    reason: string,
    client: ViewingAppointmentDbClient = prisma,
  ): Promise<{ count: number }> {
    const result = await client.viewingAppointment.updateMany({
      where: { id: appointmentId, status: VIEWING_STATUS.PENDING },
      data: {
        status: VIEWING_STATUS.REJECTED,
        rejectionReason: reason,
      },
    });

    return { count: result.count };
  }

  /**
   * Atomic conditional update: hủy lịch hẹn nếu trạng thái vẫn khớp với trạng thái mong đợi
   */
  public static async cancelAppointment(
    appointmentId: string,
    reason: string,
    expectedStatus: typeof VIEWING_STATUS.PENDING | typeof VIEWING_STATUS.CONFIRMED,
    client: ViewingAppointmentDbClient = prisma,
  ): Promise<{ count: number }> {
    const result = await client.viewingAppointment.updateMany({
      where: { id: appointmentId, status: expectedStatus },
      data: {
        status: VIEWING_STATUS.CANCELLED,
        cancellationReason: reason,
      },
    });

    return { count: result.count };
  }
}
