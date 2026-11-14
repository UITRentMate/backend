import { Prisma } from '@prisma/client';
import { type Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../../infrastructure/database/prisma';
import { type SearchRoomsQuery, type SortByOption } from './room.types';

/**
 * 5 Điều kiện lọc hiển thị công khai bắt buộc của Phase 1:
 * 1. Room.occupancyStatus = 'VACANT'
 * 2. Room.visibilityStatus = 'VISIBLE'
 * 3. Room.isArchived = false
 * 4. Property.status = 'ACTIVE'
 * 5. Property.landlord.accountStatus = 'ACTIVE'
 */
export const PUBLIC_ROOM_VISIBILITY_WHERE: Prisma.RoomWhereInput = {
  occupancyStatus: 'VACANT',
  visibilityStatus: 'VISIBLE',
  isArchived: false,
  property: {
    status: 'ACTIVE',
    landlord: {
      accountStatus: 'ACTIVE',
    },
  },
};

/**
 * Thứ tự sắp xếp hình ảnh phòng trọ chuẩn hợp đồng (sortOrder ASC, id ASC)
 */
export const ROOM_IMAGE_ORDER_BY: Prisma.RoomImageOrderByWithRelationInput[] = [
  { sortOrder: 'asc' },
  { id: 'asc' },
];

/**
 * Thứ tự sắp xếp phí dịch vụ (id ASC)
 */
export const ROOM_SERVICE_FEE_ORDER_BY: Prisma.RoomServiceFeeOrderByWithRelationInput[] = [
  { id: 'asc' },
];

/**
 * Prisma select allowlist cho RoomCardDTO (SEARCH-01):
 * Tuyệt đối không query trường nhạy cảm của người dùng.
 */
export const ROOM_CARD_SELECT = {
  id: true,
  roomCode: true,
  monthlyRent: true,
  areaM2: true,
  maxOccupants: true,
  occupancyStatus: true,
  property: {
    select: {
      id: true,
      name: true,
      address: true,
      propertyAmenities: {
        select: {
          amenity: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  },
  images: {
    orderBy: ROOM_IMAGE_ORDER_BY,
    take: 1,
    select: {
      imageUrl: true,
    },
  },
  roomAmenities: {
    select: {
      amenity: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  },
} as const;

/**
 * Prisma select allowlist cho PublicRoomDetailDTO (SEARCH-02):
 * Chỉ lấy id, fullName và đơn đăng ký chủ trọ đã duyệt; bảo mật 100% phone, email, passwordHash.
 */
export const ROOM_DETAIL_SELECT = {
  id: true,
  propertyId: true,
  roomCode: true,
  areaM2: true,
  maxOccupants: true,
  floor: true,
  monthlyRent: true,
  depositRequired: true,
  electricityRate: true,
  waterRate: true,
  occupancyStatus: true,
  createdAt: true,
  images: {
    orderBy: ROOM_IMAGE_ORDER_BY,
    select: {
      id: true,
      imageUrl: true,
      sortOrder: true,
    },
  },
  roomAmenities: {
    select: {
      amenity: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  },
  serviceFees: {
    orderBy: ROOM_SERVICE_FEE_ORDER_BY,
    select: {
      id: true,
      feeName: true,
      monthlyAmount: true,
      isRequired: true,
    },
  },
  property: {
    select: {
      id: true,
      name: true,
      address: true,
      houseRules: true,
      coverImageUrl: true,
      propertyAmenities: {
        select: {
          amenity: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
      landlord: {
        select: {
          id: true,
          fullName: true,
          landlordApplicationsAsApplicant: {
            where: { status: 'APPROVED' },
            select: { id: true },
            take: 1,
          },
        },
      },
    },
  },
} as const;

/**
 * Định nghĩa cấu trúc dữ liệu bản ghi trả về từ RoomRepository
 */
export interface PrismaRoomCardRecord {
  id: string;
  roomCode: string;
  monthlyRent: Decimal | number;
  areaM2: Decimal | number;
  maxOccupants: number;
  occupancyStatus: string;
  property: {
    id: string;
    name: string;
    address: string;
    propertyAmenities: Array<{
      amenity: {
        id: string;
        name: string;
      };
    }>;
  };
  images: Array<{
    imageUrl: string;
  }>;
  roomAmenities: Array<{
    amenity: {
      id: string;
      name: string;
    };
  }>;
}

export interface PrismaRoomDetailRecord {
  id: string;
  propertyId: string;
  roomCode: string;
  areaM2: Decimal | number;
  maxOccupants: number;
  floor: number | null;
  monthlyRent: Decimal | number;
  depositRequired: Decimal | number;
  electricityRate: Decimal | number;
  waterRate: Decimal | number;
  occupancyStatus: string;
  createdAt: Date;
  images: Array<{
    id: string;
    imageUrl: string;
    sortOrder: number;
  }>;
  roomAmenities: Array<{
    amenity: {
      id: string;
      name: string;
    };
  }>;
  serviceFees: Array<{
    id: string;
    feeName: string;
    monthlyAmount: Decimal | number;
    isRequired: boolean;
  }>;
  property: {
    id: string;
    name: string;
    address: string;
    houseRules: string | null;
    coverImageUrl: string | null;
    propertyAmenities: Array<{
      amenity: {
        id: string;
        name: string;
      };
    }>;
    landlord: {
      id: string;
      fullName: string;
      landlordApplicationsAsApplicant: Array<{
        id: string;
      }>;
    };
  };
}

export class RoomRepository {
  /**
   * Chuyển đổi bộ lọc tìm kiếm và tiêu chí Public Visibility thành Prisma.RoomWhereInput
   */
  public static buildSearchWhere(query: Partial<SearchRoomsQuery>): Prisma.RoomWhereInput {
    const conditions: Prisma.RoomWhereInput[] = [PUBLIC_ROOM_VISIBILITY_WHERE];

    // 1. Keyword search (OR trên roomCode, property.name, property.address)
    if (query.keyword) {
      conditions.push({
        OR: [
          { roomCode: { contains: query.keyword, mode: 'insensitive' } },
          { property: { name: { contains: query.keyword, mode: 'insensitive' } } },
          { property: { address: { contains: query.keyword, mode: 'insensitive' } } },
        ],
      });
    }

    // 2. Location filter (province / district trên Property.address)
    if (query.province) {
      conditions.push({
        property: {
          address: { contains: query.province, mode: 'insensitive' },
        },
      });
    }

    if (query.district) {
      conditions.push({
        property: {
          address: { contains: query.district, mode: 'insensitive' },
        },
      });
    }

    // 3. Numeric filters
    if (query.minPrice !== undefined) {
      conditions.push({ monthlyRent: { gte: query.minPrice } });
    }

    if (query.maxPrice !== undefined) {
      conditions.push({ monthlyRent: { lte: query.maxPrice } });
    }

    if (query.minArea !== undefined) {
      conditions.push({ areaM2: { gte: query.minArea } });
    }

    if (query.maxArea !== undefined) {
      conditions.push({ areaM2: { lte: query.maxArea } });
    }

    if (query.capacity !== undefined) {
      conditions.push({ maxOccupants: { gte: query.capacity } });
    }

    // 4. Amenities filter (AND logic giữa các tiện ích được yêu cầu)
    if (query.amenities && query.amenities.length > 0) {
      for (const amenityId of query.amenities) {
        conditions.push({
          OR: [
            {
              roomAmenities: {
                some: {
                  amenityId,
                },
              },
            },
            {
              property: {
                propertyAmenities: {
                  some: {
                    amenityId,
                  },
                },
              },
            },
          ],
        });
      }
    }

    return {
      AND: conditions,
    };
  }

  /**
   * Tạo mảng sắp xếp Prisma.RoomOrderByWithRelationInput với deterministic tie-breaker (id ASC)
   */
  public static buildSearchOrderBy(
    sortBy?: SortByOption
  ): Prisma.RoomOrderByWithRelationInput[] {
    switch (sortBy) {
      case 'price_asc':
        return [{ monthlyRent: 'asc' }, { id: 'asc' }];
      case 'price_desc':
        return [{ monthlyRent: 'desc' }, { id: 'asc' }];
      case 'area_asc':
        return [{ areaM2: 'asc' }, { id: 'asc' }];
      case 'area_desc':
        return [{ areaM2: 'desc' }, { id: 'asc' }];
      case 'newest':
      default:
        return [{ createdAt: 'desc' }, { id: 'asc' }];
    }
  }

  /**
   * SEARCH-01: Truy vấn danh sách phòng trọ công khai theo bộ lọc, phân trang và sắp xếp
   */
  public static async findPublicRooms(
    query: SearchRoomsQuery
  ): Promise<PrismaRoomCardRecord[]> {
    const where = RoomRepository.buildSearchWhere(query);
    const orderBy = RoomRepository.buildSearchOrderBy(query.sortBy);
    const skip = (query.page - 1) * query.pageSize;
    const take = query.pageSize;

    const records = await prisma.room.findMany({
      where,
      orderBy,
      skip,
      take,
      select: ROOM_CARD_SELECT,
    });

    return records as unknown as PrismaRoomCardRecord[];
  }

  /**
   * SEARCH-01: Đếm tổng số phòng thỏa mãn bộ lọc công khai
   */
  public static async countPublicRooms(
    query: SearchRoomsQuery
  ): Promise<number> {
    const where = RoomRepository.buildSearchWhere(query);
    return prisma.room.count({ where });
  }

  /**
   * SEARCH-02: Truy vấn chi tiết phòng trọ công khai theo roomId
   */
  public static async findPublicRoomById(
    roomId: string
  ): Promise<PrismaRoomDetailRecord | null> {
    const record = await prisma.room.findFirst({
      where: {
        id: roomId,
        ...PUBLIC_ROOM_VISIBILITY_WHERE,
      },
      select: ROOM_DETAIL_SELECT,
    });

    return record as unknown as PrismaRoomDetailRecord | null;
  }

  /**
   * SEARCH-02: Đếm tổng số phòng vật lý chưa lưu trữ của một tòa nhà
   */
  public static async countPropertyRooms(propertyId: string): Promise<number> {
    return prisma.room.count({
      where: {
        propertyId,
        isArchived: false,
      },
    });
  }

  /**
   * SEARCH-02: Đếm số phòng công khai đang trống của một tòa nhà
   */
  public static async countPropertyVacantRooms(propertyId: string): Promise<number> {
    return prisma.room.count({
      where: {
        propertyId,
        ...PUBLIC_ROOM_VISIBILITY_WHERE,
      },
    });
  }
}
