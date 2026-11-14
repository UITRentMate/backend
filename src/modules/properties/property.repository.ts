import type { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import type {
  CreatePropertyInput,
  UpdatePropertyInput,
  PropertyListQuery,
} from './property.types';

export class PropertyRepository {
  /**
   * Kiểm tra tính hợp lệ của danh sách amenityIds:
   * Tất cả UUID phải tồn tại trong DB và không được mang scope là ROOM (phải là PROPERTY hoặc tương thích).
   */
  public static async validateAmenityIds(amenityIds: string[]): Promise<boolean> {
    if (!amenityIds || amenityIds.length === 0) return true;

    const uniqueIds = Array.from(new Set(amenityIds));
    const count = await prisma.amenity.count({
      where: {
        id: { in: uniqueIds },
        scope: { not: 'ROOM' },
      },
    });

    return count === uniqueIds.length;
  }

  /**
   * Tạo khu trọ mới kèm danh sách tiện ích trong 1 transaction an toàn
   */
  public static async createProperty(landlordId: string, data: CreatePropertyInput) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const property = await tx.property.create({
        data: {
          landlordId,
          name: data.name,
          address: data.address,
          houseRules: data.houseRules,
          coverImageUrl: data.coverImageUrl,
          status: 'ACTIVE',
        },
      });

      if (data.amenityIds && data.amenityIds.length > 0) {
        const uniqueIds = Array.from(new Set(data.amenityIds));
        await tx.propertyAmenity.createMany({
          data: uniqueIds.map((amenityId) => ({
            propertyId: property.id,
            amenityId,
          })),
          skipDuplicates: true,
        });
      }

      return tx.property.findUniqueOrThrow({
        where: { id: property.id },
        include: {
          propertyAmenities: {
            include: { amenity: true },
          },
          rooms: true,
          landlord: {
            select: { id: true, fullName: true, accountStatus: true },
          },
        },
      });
    });
  }

  /**
   * Tìm kiếm danh sách khu trọ của chủ trọ có phân trang và lọc trạng thái
   */
  public static async findLandlordProperties(
    landlordId: string,
    query: PropertyListQuery,
  ): Promise<{ items: any[]; totalItems: number }> {
    const where: any = { landlordId };

    if (query.status) {
      where.status = query.status;
    }

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { address: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [totalItems, items] = await Promise.all([
      prisma.property.count({ where }),
      prisma.property.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        include: {
          propertyAmenities: {
            include: { amenity: true },
          },
          rooms: {
            select: {
              occupancyStatus: true,
              visibilityStatus: true,
              isArchived: true,
            },
          },
        },
      }),
    ]);

    return { items, totalItems };
  }

  /**
   * Lấy chi tiết khu trọ kèm danh sách phòng, tiện ích và chủ trọ
   */
  public static async findPropertyById(propertyId: string) {
    return prisma.property.findUnique({
      where: { id: propertyId },
      include: {
        propertyAmenities: {
          include: { amenity: true },
        },
        rooms: {
          orderBy: [{ floor: 'asc' }, { roomCode: 'asc' }],
          include: {
            images: {
              orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
              take: 1,
            },
          },
        },
        landlord: {
          select: { id: true, fullName: true, accountStatus: true },
        },
      },
    });
  }

  /**
   * Cập nhật thông tin khu trọ và thay thế toàn bộ (replace full set) danh sách tiện ích
   */
  public static async updateProperty(propertyId: string, data: UpdatePropertyInput) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.propertyAmenity.deleteMany({
        where: { propertyId },
      });

      if (data.amenityIds && data.amenityIds.length > 0) {
        const uniqueIds = Array.from(new Set(data.amenityIds));
        await tx.propertyAmenity.createMany({
          data: uniqueIds.map((amenityId) => ({
            propertyId,
            amenityId,
          })),
          skipDuplicates: true,
        });
      }

      await tx.property.update({
        where: { id: propertyId },
        data: {
          name: data.name,
          address: data.address,
          houseRules: data.houseRules,
          coverImageUrl: data.coverImageUrl,
        },
      });

      return tx.property.findUniqueOrThrow({
        where: { id: propertyId },
        include: {
          propertyAmenities: {
            include: { amenity: true },
          },
          rooms: {
            orderBy: [{ floor: 'asc' }, { roomCode: 'asc' }],
          },
          landlord: {
            select: { id: true, fullName: true, accountStatus: true },
          },
        },
      });
    });
  }

  /**
   * Chuyển trạng thái khu trọ thành ARCHIVED
   */
  public static async archiveProperty(propertyId: string) {
    return prisma.property.update({
      where: { id: propertyId },
      data: { status: 'ARCHIVED' },
    });
  }

  /**
   * Đếm số lượng hợp đồng thuê đang có hiệu lực đối với các phòng trong khu trọ.
   * Các trạng thái kết thúc/không còn hiệu lực gồm: TERMINATED, CANCELLED, EXPIRED, LIQUIDATED.
   */
  public static async countActiveContracts(propertyId: string): Promise<number> {
    return prisma.contract.count({
      where: {
        room: { propertyId },
        status: { notIn: ['TERMINATED', 'CANCELLED', 'EXPIRED', 'LIQUIDATED'] },
      },
    });
  }
}
