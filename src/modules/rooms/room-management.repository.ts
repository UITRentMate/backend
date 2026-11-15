import type { Prisma } from '@prisma/client';
import { ApiError } from '../../common/errors/api-error';
import { prisma } from '../../infrastructure/database/prisma';
import type {
  CreateRoomInput,
  UpdateRoomInput,
  LandlordRoomListQuery,
  RoomStatusSummary,
} from './room-management.types';

const ROOM_DETAIL_INCLUDE: Prisma.RoomInclude = {
  roomAmenities: {
    include: { amenity: true },
  },
  serviceFees: {
    orderBy: { feeName: 'asc' },
  },
  images: {
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  },
  property: {
    select: {
      id: true,
      name: true,
      address: true,
      status: true,
    },
  },
};

export class RoomManagementRepository {
  /**
   * Kiểm tra quyền sở hữu của chủ trọ đối với một khu trọ (Property)
   */
  public static async checkPropertyOwnership(
    propertyId: string,
    landlordId: string,
  ): Promise<boolean> {
    const count = await prisma.property.count({
      where: {
        id: propertyId,
        landlordId,
      },
    });
    return count > 0;
  }

  /**
   * Kiểm tra quyền sở hữu của chủ trọ đối với một phòng trọ (thông qua property.landlordId)
   */
  public static async checkRoomOwnership(
    roomId: string,
    landlordId: string,
  ): Promise<boolean> {
    const count = await prisma.room.count({
      where: {
        id: roomId,
        property: {
          landlordId,
        },
      },
    });
    return count > 0;
  }

  /**
   * Kiểm tra trùng lặp mã phòng trong cùng một khu trọ (hỗ trợ loại trừ phòng hiện tại khi update)
   */
  public static async checkDuplicateRoomCode(
    propertyId: string,
    roomCode: string,
    excludeRoomId?: string,
  ): Promise<boolean> {
    const where: Prisma.RoomWhereInput = {
      propertyId,
      roomCode: {
        equals: roomCode.trim(),
        mode: 'insensitive',
      },
    };

    if (excludeRoomId) {
      where.id = { not: excludeRoomId };
    }

    const count = await prisma.room.count({ where });
    return count > 0;
  }

  /**
   * Kiểm tra xem phòng có hợp đồng hiệu lực (ACTIVE, PENDING) hoặc yêu cầu thuê đang xử lý (PENDING, ACCEPTED) không.
   * Dùng để chặn cứng khi chuyển phòng sang trạng thái MAINTENANCE (bảo trì).
   */
  public static async checkActiveContractsOrRequests(roomId: string): Promise<boolean> {
    const [activeContractsCount, pendingRequestsCount] = await Promise.all([
      prisma.contract.count({
        where: {
          roomId,
          status: { notIn: ['TERMINATED', 'CANCELLED', 'EXPIRED', 'LIQUIDATED'] },
        },
      }),
      prisma.rentalRequest.count({
        where: {
          roomId,
          status: { in: ['PENDING', 'ACCEPTED'] },
        },
      }),
    ]);

    return activeContractsCount > 0 || pendingRequestsCount > 0;
  }

  /**
   * Kiểm tra tính hợp lệ của danh sách amenityIds:
   * Tất cả UUID phải tồn tại trong DB và không mang scope là PROPERTY (phải là ROOM hoặc BOTH).
   */
  public static async validateAmenityIds(amenityIds: string[]): Promise<boolean> {
    if (!amenityIds || amenityIds.length === 0) return true;

    const uniqueIds = Array.from(new Set(amenityIds));
    const count = await prisma.amenity.count({
      where: {
        id: { in: uniqueIds },
        scope: { not: 'PROPERTY' },
      },
    });

    return count === uniqueIds.length;
  }

  /**
   * Tạo phòng trọ mới kèm danh sách tiện ích và phí dịch vụ trong 1 transaction an toàn
   */
  public static async createRoomTransaction(propertyId: string, data: CreateRoomInput) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Kiểm tra trùng lặp mã phòng trong transaction để bảo vệ tính duy nhất khi có concurrent requests
      const duplicateCount = await tx.room.count({
        where: {
          propertyId,
          roomCode: {
            equals: data.roomCode.trim(),
            mode: 'insensitive',
          },
        },
      });
      if (duplicateCount > 0) {
        throw new ApiError(
          409,
          'DUPLICATE_ROOM_CODE',
          `Mã phòng '${data.roomCode}' đã tồn tại trong khu trọ này`,
        );
      }

      const room = await tx.room.create({
        data: {
          propertyId,
          roomCode: data.roomCode.trim(),
          floor: data.floor ?? null,
          areaM2: data.areaM2,
          maxOccupants: data.maxOccupants,
          monthlyRent: data.monthlyRent,
          depositRequired: data.depositRequired,
          electricityRate: data.electricityRate,
          waterRate: data.waterRate,
          occupancyStatus: 'VACANT',
          visibilityStatus: 'HIDDEN',
          isArchived: false,
        },
      });

      if (data.amenityIds && data.amenityIds.length > 0) {
        const uniqueAmenityIds = Array.from(new Set(data.amenityIds));
        await tx.roomAmenity.createMany({
          data: uniqueAmenityIds.map((amenityId) => ({
            roomId: room.id,
            amenityId,
          })),
          skipDuplicates: true,
        });
      }

      if (data.serviceFees && data.serviceFees.length > 0) {
        await tx.roomServiceFee.createMany({
          data: data.serviceFees.map((fee) => ({
            roomId: room.id,
            feeName: fee.feeName.trim(),
            monthlyAmount: fee.monthlyAmount,
            isRequired: fee.isRequired ?? false,
          })),
        });
      }

      return tx.room.findUniqueOrThrow({
        where: { id: room.id },
        include: {
          roomAmenities: {
            include: { amenity: true },
          },
          serviceFees: {
            orderBy: { feeName: 'asc' },
          },
          images: {
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          },
          property: {
            select: {
              id: true,
              name: true,
              address: true,
              status: true,
            },
          },
        },
      });
    });
  }

  /**
   * Cập nhật thông tin phòng và thay thế toàn bộ (Full Replace) danh sách tiện ích, phí dịch vụ trong transaction
   */
  public static async updateRoomTransaction(roomId: string, data: UpdateRoomInput) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // 1. Kiểm tra trùng lặp mã phòng trong transaction nếu có cập nhật roomCode
      const currentRoom = await tx.room.findUnique({
        where: { id: roomId },
        select: { propertyId: true },
      });
      if (currentRoom) {
        const duplicateCount = await tx.room.count({
          where: {
            propertyId: currentRoom.propertyId,
            roomCode: {
              equals: data.roomCode.trim(),
              mode: 'insensitive',
            },
            id: { not: roomId },
          },
        });
        if (duplicateCount > 0) {
          throw new ApiError(
            409,
            'DUPLICATE_ROOM_CODE',
            `Mã phòng '${data.roomCode}' đã tồn tại trong khu trọ này`,
          );
        }
      }

      // 2. Xóa các tiện ích và phí dịch vụ cũ
      await tx.roomAmenity.deleteMany({
        where: { roomId },
      });
      await tx.roomServiceFee.deleteMany({
        where: { roomId },
      });

      // 3. Tạo mới danh mục tiện ích
      if (data.amenityIds && data.amenityIds.length > 0) {
        const uniqueAmenityIds = Array.from(new Set(data.amenityIds));
        await tx.roomAmenity.createMany({
          data: uniqueAmenityIds.map((amenityId) => ({
            roomId,
            amenityId,
          })),
          skipDuplicates: true,
        });
      }

      // 4. Tạo mới danh mục phí dịch vụ
      if (data.serviceFees && data.serviceFees.length > 0) {
        await tx.roomServiceFee.createMany({
          data: data.serviceFees.map((fee) => ({
            roomId,
            feeName: fee.feeName.trim(),
            monthlyAmount: fee.monthlyAmount,
            isRequired: fee.isRequired ?? false,
          })),
        });
      }

      // 5. Cập nhật thông số phòng
      await tx.room.update({
        where: { id: roomId },
        data: {
          roomCode: data.roomCode.trim(),
          floor: data.floor ?? null,
          areaM2: data.areaM2,
          maxOccupants: data.maxOccupants,
          monthlyRent: data.monthlyRent,
          depositRequired: data.depositRequired,
          electricityRate: data.electricityRate,
          waterRate: data.waterRate,
        },
      });

      // 6. Trả về thông tin phòng chi tiết sau cập nhật
      return tx.room.findUniqueOrThrow({
        where: { id: roomId },
        include: ROOM_DETAIL_INCLUDE,
      });
    });
  }

  /**
   * Truy vấn danh sách phòng thuộc khu trọ có phân trang, lọc và thống kê counters song song
   */
  public static async findLandlordRooms(
    propertyId: string,
    query: LandlordRoomListQuery,
  ): Promise<{ items: any[]; totalItems: number; summary: RoomStatusSummary }> {
    const where: Prisma.RoomWhereInput = {
      propertyId,
      isArchived: false,
    };

    if (query.occupancyStatus) {
      where.occupancyStatus = query.occupancyStatus;
    }

    if (query.visibilityStatus) {
      where.visibilityStatus = query.visibilityStatus;
    }

    if (query.search) {
      where.roomCode = {
        contains: query.search,
        mode: 'insensitive',
      };
    }

    const [allRoomsInProperty, totalItems, items] = await Promise.all([
      // Lấy toàn bộ phòng không bị archived trong khu trọ để tính summary counters
      prisma.room.findMany({
        where: { propertyId, isArchived: false },
        select: { occupancyStatus: true, visibilityStatus: true },
      }),
      // Đếm tổng số bản ghi khớp bộ lọc tìm kiếm
      prisma.room.count({ where }),
      // Lấy danh sách phòng theo phân trang
      prisma.room.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: [{ floor: 'asc' }, { roomCode: 'asc' }, { id: 'asc' }],
        include: {
          images: {
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          },
          roomAmenities: {
            include: { amenity: true },
          },
          serviceFees: true,
        },
      }),
    ]);

    const summary: RoomStatusSummary = {
      total: allRoomsInProperty.length,
      vacant: allRoomsInProperty.filter((r) => r.occupancyStatus === 'VACANT').length,
      maintenance: allRoomsInProperty.filter((r) => r.occupancyStatus === 'MAINTENANCE').length,
      rented: allRoomsInProperty.filter((r) => r.occupancyStatus === 'RENTED').length,
      held: allRoomsInProperty.filter((r) => r.occupancyStatus === 'HELD').length,
      visible: allRoomsInProperty.filter((r) => r.visibilityStatus === 'VISIBLE').length,
      hidden: allRoomsInProperty.filter((r) => r.visibilityStatus === 'HIDDEN').length,
    };

    return { items, totalItems, summary };
  }

  /**
   * Lấy chi tiết phòng toàn diện để quản lý kèm toàn bộ quan hệ
   */
  public static async findLandlordRoomById(roomId: string) {
    return prisma.room.findUnique({
      where: { id: roomId },
      include: {
        roomAmenities: {
          include: { amenity: true },
        },
        serviceFees: {
          orderBy: { feeName: 'asc' },
        },
        images: {
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        },
        property: {
          select: {
            id: true,
            landlordId: true,
            name: true,
            address: true,
            status: true,
            landlord: {
              select: {
                id: true,
                accountStatus: true,
              },
            },
          },
        },
      },
    });
  }

  /**
   * Chuyển trạng thái vận hành sang MAINTENANCE một cách nguyên tử (Atomic Blocker Check & Status Update)
   * 1. Kiểm tra nguyên tử không có hợp đồng hiệu lực hoặc yêu cầu thuê đang xử lý.
   * 2. Cập nhật có điều kiện: chỉ phòng đang VACANT mới được chuyển sang MAINTENANCE.
   * 3. Tự động hạ visibilityStatus về HIDDEN.
   */
  public static async transitionToMaintenanceTransaction(roomId: string) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // 1. Kiểm tra nguyên tử các blockers (hợp đồng hiệu lực hoặc yêu cầu thuê đang xử lý)
      const [activeContractsCount, pendingRequestsCount] = await Promise.all([
        tx.contract.count({
          where: {
            roomId,
            status: { notIn: ['TERMINATED', 'CANCELLED', 'EXPIRED', 'LIQUIDATED'] },
          },
        }),
        tx.rentalRequest.count({
          where: {
            roomId,
            status: { in: ['PENDING', 'ACCEPTED'] },
          },
        }),
      ]);

      if (activeContractsCount > 0 || pendingRequestsCount > 0) {
        throw new ApiError(
          409,
          'CANNOT_MAINTAIN_ACTIVE_ROOM',
          'Không thể chuyển sang bảo trì khi phòng đang có hợp đồng hoặc yêu cầu thuê có hiệu lực',
        );
      }

      // 2. Cập nhật có điều kiện: chỉ đổi trạng thái nếu phòng đang VACANT
      const updateResult = await tx.room.updateMany({
        where: {
          id: roomId,
          occupancyStatus: 'VACANT',
        },
        data: {
          occupancyStatus: 'MAINTENANCE',
          visibilityStatus: 'HIDDEN',
        },
      });

      if (updateResult.count === 0) {
        throw new ApiError(
          409,
          'INVALID_STATUS_TRANSITION',
          'Không thể chuyển sang bảo trì vì trạng thái phòng đã bị thay đổi (yêu cầu phòng ở trạng thái VACANT)',
        );
      }

      return tx.room.findUniqueOrThrow({
        where: { id: roomId },
        include: ROOM_DETAIL_INCLUDE,
      });
    });
  }

  /**
   * Chuyển trạng thái vận hành từ MAINTENANCE về VACANT một cách nguyên tử (Conditional Update)
   * Giữ nguyên visibilityStatus hiện tại.
   */
  public static async transitionToVacantTransaction(roomId: string) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Cập nhật có điều kiện: chỉ phòng đang MAINTENANCE mới được chuyển về VACANT
      const updateResult = await tx.room.updateMany({
        where: {
          id: roomId,
          occupancyStatus: 'MAINTENANCE',
        },
        data: {
          occupancyStatus: 'VACANT',
        },
      });

      if (updateResult.count === 0) {
        throw new ApiError(
          409,
          'INVALID_STATUS_TRANSITION',
          'Không thể chuyển về VACANT vì trạng thái phòng đã bị thay đổi (yêu cầu phòng ở trạng thái MAINTENANCE)',
        );
      }

      return tx.room.findUniqueOrThrow({
        where: { id: roomId },
        include: ROOM_DETAIL_INCLUDE,
      });
    });
  }

  /**
   * Cập nhật trạng thái vận hành của phòng (và tự động chuyển visibilityStatus = 'HIDDEN' nếu có newVisibility)
   */
  public static async updateOperationalStatus(
    roomId: string,
    status: string,
    newVisibility?: string,
  ) {
    const data: Prisma.RoomUpdateInput = {
      occupancyStatus: status,
    };

    if (newVisibility) {
      data.visibilityStatus = newVisibility;
    }

    return prisma.room.update({
      where: { id: roomId },
      data,
      include: {
        roomAmenities: {
          include: { amenity: true },
        },
        serviceFees: {
          orderBy: { feeName: 'asc' },
        },
        images: {
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        },
        property: {
          select: {
            id: true,
            name: true,
            address: true,
            status: true,
          },
        },
      },
    });
  }

  /**
   * Cập nhật trạng thái hiển thị công khai (visibilityStatus) của phòng
   */
  public static async updateVisibility(roomId: string, visibility: string) {
    return prisma.room.update({
      where: { id: roomId },
      data: {
        visibilityStatus: visibility,
      },
      include: {
        roomAmenities: {
          include: { amenity: true },
        },
        serviceFees: {
          orderBy: { feeName: 'asc' },
        },
        images: {
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        },
        property: {
          select: {
            id: true,
            name: true,
            address: true,
            status: true,
          },
        },
      },
    });
  }
}
