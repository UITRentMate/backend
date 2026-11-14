import { ApiError } from '../../common/errors/api-error';
import { PropertyRepository } from './property.repository';
import {
  mapToLandlordPropertyCard,
  mapToLandlordPropertyDetail,
  mapToPublicPropertyDetail,
} from './property.mapper';
import type {
  CreatePropertyInput,
  UpdatePropertyInput,
  PropertyListQuery,
  PaginatedLandlordProperties,
  LandlordPropertyDetailDTO,
  PublicPropertyDetailDTO,
} from './property.types';

export class PropertyService {
  /**
   * Tạo khu trọ mới cho chủ trọ
   */
  public static async createProperty(
    landlordId: string,
    input: CreatePropertyInput,
  ): Promise<LandlordPropertyDetailDTO> {
    const amenitiesValid = await PropertyRepository.validateAmenityIds(input.amenityIds);
    if (!amenitiesValid) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'Một hoặc nhiều tiện ích không tồn tại hoặc không phù hợp với khu trọ',
        { amenityIds: ['Tiện ích không hợp lệ hoặc không thuộc phạm vi khu trọ'] },
      );
    }

    const property = await PropertyRepository.createProperty(landlordId, input);
    const stats = PropertyRepository.calculateRoomStats(property.rooms ?? []);
    return mapToLandlordPropertyDetail(property, stats);
  }

  /**
   * Lấy danh sách khu trọ của chủ trọ có phân trang và lọc
   */
  public static async getLandlordProperties(
    landlordId: string,
    query: PropertyListQuery,
  ): Promise<PaginatedLandlordProperties> {
    const { items, totalItems } = await PropertyRepository.findLandlordProperties(
      landlordId,
      query,
    );

    const cards = items.map((item) => {
      const stats = PropertyRepository.calculateRoomStats(item.rooms ?? []);
      return mapToLandlordPropertyCard(item, stats);
    });

    const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / query.pageSize);

    return {
      items: cards,
      page: query.page,
      pageSize: query.pageSize,
      totalItems,
      totalPages,
    };
  }

  /**
   * Xem chi tiết khu trọ để quản lý (Chủ trọ xem được cả phòng ẩn/bảo trì)
   * Trả về 404 nếu không tìm thấy hoặc khu trọ thuộc chủ trọ khác (để bảo mật chống dò quét ID)
   */
  public static async getLandlordPropertyDetail(
    landlordId: string,
    propertyId: string,
  ): Promise<LandlordPropertyDetailDTO> {
    const property = await PropertyRepository.findPropertyById(propertyId);

    if (!property || property.landlordId !== landlordId) {
      throw new ApiError(
        404,
        'PROPERTY_NOT_FOUND',
        'Khu trọ không tồn tại hoặc bạn không có quyền truy cập',
      );
    }

    const stats = PropertyRepository.calculateRoomStats(property.rooms ?? []);
    return mapToLandlordPropertyDetail(property, stats);
  }

  /**
   * Xem chi tiết khu trọ công khai dành cho khách tìm trọ
   * Chỉ hiển thị khi Property ACTIVE, Landlord ACTIVE, và có ít nhất 1 phòng thỏa Room Discovery
   */
  public static async getPublicPropertyDetail(
    propertyId: string,
  ): Promise<PublicPropertyDetailDTO> {
    const property = await PropertyRepository.findPropertyById(propertyId);

    if (
      !property ||
      property.status !== 'ACTIVE' ||
      property.landlord.accountStatus !== 'ACTIVE'
    ) {
      throw new ApiError(
        404,
        'PROPERTY_NOT_FOUND',
        'Khu trọ không tồn tại hoặc hiện không khả dụng',
      );
    }

    // Lọc các phòng đáp ứng đầy đủ chính sách công khai Room Discovery
    const publicRooms = (property.rooms ?? []).filter(
      (room: any) =>
        room.occupancyStatus === 'VACANT' &&
        room.visibilityStatus === 'VISIBLE' &&
        !room.isArchived,
    );

    if (publicRooms.length === 0) {
      throw new ApiError(
        404,
        'PROPERTY_NOT_FOUND',
        'Khu trọ không tồn tại hoặc hiện không khả dụng',
      );
    }

    // Giới hạn tối đa 50 phòng trong response công khai
    const cappedRooms = publicRooms.slice(0, 50);

    return mapToPublicPropertyDetail(property, cappedRooms, publicRooms.length);
  }

  /**
   * Cập nhật thông tin khu trọ
   */
  public static async updateProperty(
    landlordId: string,
    propertyId: string,
    input: UpdatePropertyInput,
  ): Promise<LandlordPropertyDetailDTO> {
    const existing = await PropertyRepository.findPropertyById(propertyId);

    if (!existing || existing.landlordId !== landlordId) {
      throw new ApiError(
        404,
        'PROPERTY_NOT_FOUND',
        'Khu trọ không tồn tại hoặc bạn không có quyền truy cập',
      );
    }

    const amenitiesValid = await PropertyRepository.validateAmenityIds(input.amenityIds);
    if (!amenitiesValid) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'Một hoặc nhiều tiện ích không tồn tại hoặc không phù hợp với khu trọ',
        { amenityIds: ['Tiện ích không hợp lệ hoặc không thuộc phạm vi khu trọ'] },
      );
    }

    const updated = await PropertyRepository.updateProperty(propertyId, input);
    const stats = PropertyRepository.calculateRoomStats(updated.rooms ?? []);
    return mapToLandlordPropertyDetail(updated, stats);
  }

  /**
   * Lưu trữ khu trọ (Archive)
   * Chặn nếu khu trọ còn phòng đang có hợp đồng hoặc người thuê (RENTED / HELD)
   */
  public static async archiveProperty(
    landlordId: string,
    propertyId: string,
  ): Promise<void> {
    const existing = await PropertyRepository.findPropertyById(propertyId);

    if (!existing || existing.landlordId !== landlordId) {
      throw new ApiError(
        404,
        'PROPERTY_NOT_FOUND',
        'Khu trọ không tồn tại hoặc bạn không có quyền truy cập',
      );
    }

    const activeOccupiedRooms = (existing.rooms ?? []).filter(
      (room: any) =>
        !room.isArchived &&
        (room.occupancyStatus === 'RENTED' || room.occupancyStatus === 'HELD'),
    );

    if (activeOccupiedRooms.length > 0) {
      throw new ApiError(
        409,
        'CONFLICT',
        'Không thể lưu trữ khu trọ khi vẫn còn phòng đang có hợp đồng hoặc người thuê',
      );
    }

    await PropertyRepository.archiveProperty(propertyId);
  }
}
