import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import type { RentalRequestFilterQuery } from './rental-request.types';

export class RentalRequestRepository {
  /**
   * Kiểm tra điều kiện phòng công khai đủ điều kiện gửi yêu cầu (Room Discovery Phase 1)
   */
  public static async findEligiblePublicRoom(
    roomId: string,
    client: Prisma.TransactionClient | typeof prisma = prisma,
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
      },
    });
  }

  /**
   * Kiểm tra người thuê đã có yêu cầu PENDING cho phòng này hay chưa
   */
  public static async findPendingByTenantAndRoom(
    tenantId: string,
    roomId: string,
    client: Prisma.TransactionClient | typeof prisma = prisma,
  ) {
    return client.rentalRequest.findFirst({
      where: {
        tenantId,
        roomId,
        status: 'PENDING',
      },
      select: {
        id: true,
      },
    });
  }

  /**
   * Tạo yêu cầu thuê mới
   */
  public static async createRentalRequest(
    data: {
      roomId: string;
      tenantId: string;
      desiredStartDate: Date;
      durationMonths?: number | null;
      message?: string | null;
    },
    client: Prisma.TransactionClient | typeof prisma = prisma,
  ) {
    return client.rentalRequest.create({
      data: {
        roomId: data.roomId,
        tenantId: data.tenantId,
        desiredStartDate: data.desiredStartDate,
        durationMonths: data.durationMonths ?? null,
        message: data.message ?? null,
        status: 'PENDING',
      },
    });
  }

  /**
   * Lấy danh sách yêu cầu thuê của Người thuê (Tenant)
   */
  public static async findRequestsByTenant(
    tenantId: string,
    query: RentalRequestFilterQuery,
  ) {
    const where: Prisma.RentalRequestWhereInput = {
      tenantId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.roomId ? { roomId: query.roomId } : {}),
    };

    const [items, totalItems] = await Promise.all([
      prisma.rentalRequest.findMany({
        where,
        select: {
          id: true,
          roomId: true,
          tenantId: true,
          desiredStartDate: true,
          durationMonths: true,
          message: true,
          status: true,
          rejectionReason: true,
          reviewedAt: true,
          createdAt: true,
          room: {
            select: {
              id: true,
              roomCode: true,
              property: {
                select: {
                  id: true,
                  name: true,
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
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.rentalRequest.count({ where }),
    ]);

    return { items, totalItems };
  }

  /**
   * Lấy danh sách yêu cầu thuê của Chủ trọ (Landlord) thuộc các khu trọ do mình sở hữu
   */
  public static async findRequestsByLandlord(
    landlordId: string,
    query: RentalRequestFilterQuery,
  ) {
    const where: Prisma.RentalRequestWhereInput = {
      room: {
        property: {
          landlordId,
        },
      },
      ...(query.status ? { status: query.status } : {}),
      ...(query.roomId ? { roomId: query.roomId } : {}),
    };

    const [items, totalItems] = await Promise.all([
      prisma.rentalRequest.findMany({
        where,
        select: {
          id: true,
          roomId: true,
          tenantId: true,
          desiredStartDate: true,
          durationMonths: true,
          message: true,
          status: true,
          rejectionReason: true,
          reviewedAt: true,
          createdAt: true,
          room: {
            select: {
              id: true,
              roomCode: true,
              property: {
                select: {
                  id: true,
                  name: true,
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
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.rentalRequest.count({ where }),
    ]);

    return { items, totalItems };
  }

  /**
   * Xem chi tiết yêu cầu thuê với phân quyền scoped
   */
  public static async findDetailById(
    requestId: string,
    user: { id: string; role: string },
  ) {
    const where: Prisma.RentalRequestWhereInput =
      user.role === 'LANDLORD'
        ? { id: requestId, room: { property: { landlordId: user.id } } }
        : { id: requestId, tenantId: user.id };

    return prisma.rentalRequest.findFirst({
      where,
      select: {
        id: true,
        roomId: true,
        tenantId: true,
        desiredStartDate: true,
        durationMonths: true,
        message: true,
        status: true,
        rejectionReason: true,
        reviewedAt: true,
        createdAt: true,
        room: {
          select: {
            id: true,
            roomCode: true,
            monthlyRent: true,
            property: {
              select: {
                id: true,
                name: true,
                address: true,
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
      },
    });
  }

  /**
   * Tìm yêu cầu thuê của chủ trọ (dùng cho kiểm tra phân quyền & race condition)
   */
  public static async findLandlordRentalRequestById(
    requestId: string,
    landlordId: string,
  ) {
    return prisma.rentalRequest.findFirst({
      where: {
        id: requestId,
        room: {
          property: {
            landlordId,
          },
        },
      },
      select: {
        id: true,
        status: true,
        rejectionReason: true,
        reviewedAt: true,
      },
    });
  }

  /**
   * Atomic conditional update: chuyển trạng thái PENDING -> REJECTED kèm lý do
   */
  public static async rejectPendingRequest(
    requestId: string,
    landlordId: string,
    reason: string,
  ) {
    const now = new Date();
    const result = await prisma.rentalRequest.updateMany({
      where: {
        id: requestId,
        status: 'PENDING',
        room: {
          property: {
            landlordId,
          },
        },
      },
      data: {
        status: 'REJECTED',
        rejectionReason: reason,
        reviewedAt: now,
      },
    });

    return { count: result.count, reviewedAt: now };
  }
}
