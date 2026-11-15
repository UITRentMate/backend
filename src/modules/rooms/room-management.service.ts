import { ApiError } from '../../common/errors/api-error';
import { RoomManagementRepository } from './room-management.repository';
import type {
  CreateRoomInput,
  UpdateRoomInput,
  UpdateOperationalStatusInput,
  UpdateVisibilityInput,
  LandlordRoomListQuery,
  PaginatedLandlordRoomsResponse,
  LandlordRoomDetailResponse,
  LandlordRoomItemDTO,
} from './room-management.types';

/**
 * Chuyển đổi an toàn từ Decimal/number sang number tiêu chuẩn
 */
function toNumber(val: unknown): number {
  if (typeof val === 'number') return val;
  if (val && typeof (val as any).toNumber === 'function') {
    return (val as any).toNumber();
  }
  return Number(val);
}

/**
 * Ánh xạ dữ liệu bản ghi phòng sang LandlordRoomDetailResponse
 */
function mapToLandlordRoomDetail(room: any): LandlordRoomDetailResponse {
  return {
    id: room.id,
    propertyId: room.propertyId,
    roomCode: room.roomCode,
    floor: room.floor ?? null,
    areaM2: toNumber(room.areaM2),
    maxOccupants: room.maxOccupants,
    monthlyRent: toNumber(room.monthlyRent),
    depositRequired: toNumber(room.depositRequired),
    electricityRate: toNumber(room.electricityRate),
    waterRate: toNumber(room.waterRate),
    occupancyStatus: room.occupancyStatus,
    visibilityStatus: room.visibilityStatus,
    isArchived: room.isArchived,
    amenities: (room.roomAmenities ?? []).map((ra: any) => ({
      id: ra.amenity.id,
      name: ra.amenity.name,
      scope: ra.amenity.scope,
    })),
    serviceFees: (room.serviceFees ?? []).map((fee: any) => ({
      id: fee.id,
      feeName: fee.feeName,
      monthlyAmount: toNumber(fee.monthlyAmount),
      isRequired: fee.isRequired,
    })),
    images: (room.images ?? []).map((img: any) => ({
      id: img.id,
      imageUrl: img.imageUrl,
      sortOrder: img.sortOrder,
      createdAt:
        img.createdAt instanceof Date ? img.createdAt.toISOString() : String(img.createdAt),
    })),
    createdAt:
      room.createdAt instanceof Date ? room.createdAt.toISOString() : String(room.createdAt),
  };
}

/**
 * Ánh xạ dữ liệu bản ghi phòng sang LandlordRoomItemDTO (cho danh sách phân trang)
 */
function mapToLandlordRoomItem(room: any): LandlordRoomItemDTO {
  const images = room.images ?? [];
  return {
    id: room.id,
    propertyId: room.propertyId,
    roomCode: room.roomCode,
    floor: room.floor ?? null,
    areaM2: toNumber(room.areaM2),
    maxOccupants: room.maxOccupants,
    monthlyRent: toNumber(room.monthlyRent),
    depositRequired: toNumber(room.depositRequired),
    electricityRate: toNumber(room.electricityRate),
    waterRate: toNumber(room.waterRate),
    occupancyStatus: room.occupancyStatus,
    visibilityStatus: room.visibilityStatus,
    isArchived: room.isArchived,
    coverImageUrl: images[0]?.imageUrl ?? null,
    totalImages: images.length,
    createdAt:
      room.createdAt instanceof Date ? room.createdAt.toISOString() : String(room.createdAt),
  };
}

export class RoomManagementService {
  /**
   * ROOM-01: Tạo phòng trọ mới kèm tiện ích và phí dịch vụ
   */
  public static async createRoom(
    landlordId: string,
    propertyId: string,
    input: CreateRoomInput,
  ): Promise<LandlordRoomDetailResponse> {
    // 1. Kiểm tra quyền sở hữu khu trọ (Chống rò rỉ ID bằng mã lỗi 404 NOT_FOUND)
    const isOwner = await RoomManagementRepository.checkPropertyOwnership(
      propertyId,
      landlordId,
    );
    if (!isOwner) {
      throw new ApiError(
        404,
        'PROPERTY_NOT_FOUND',
        'Khu trọ không tồn tại hoặc bạn không có quyền truy cập',
      );
    }

    // 2. Kiểm tra trùng mã phòng trong cùng khu trọ
    const isDuplicate = await RoomManagementRepository.checkDuplicateRoomCode(
      propertyId,
      input.roomCode,
    );
    if (isDuplicate) {
      throw new ApiError(
        409,
        'ROOM_CODE_ALREADY_EXISTS',
        'Mã phòng đã tồn tại trong khu trọ này',
      );
    }

    // 3. Kiểm tra tính hợp lệ của tiện ích
    if (input.amenityIds && input.amenityIds.length > 0) {
      const areAmenitiesValid = await RoomManagementRepository.validateAmenityIds(
        input.amenityIds,
      );
      if (!areAmenitiesValid) {
        throw new ApiError(
          400,
          'VALIDATION_ERROR',
          'Một hoặc nhiều tiện ích không tồn tại hoặc không phù hợp với phòng trọ',
          { amenityIds: ['Tiện ích không hợp lệ hoặc không thuộc phạm vi phòng'] },
        );
      }
    }

    // 4. Ủy quyền tạo phòng trong Database Transaction qua Repository
    const room = await RoomManagementRepository.createRoomTransaction(
      propertyId,
      input,
    );

    return mapToLandlordRoomDetail(room);
  }

  /**
   * ROOM-02: Lấy danh sách phòng thuộc khu trọ có phân trang và bộ đếm trạng thái
   */
  public static async getLandlordRooms(
    landlordId: string,
    propertyId: string,
    query: LandlordRoomListQuery,
  ): Promise<PaginatedLandlordRoomsResponse> {
    const isOwner = await RoomManagementRepository.checkPropertyOwnership(
      propertyId,
      landlordId,
    );
    if (!isOwner) {
      throw new ApiError(
        404,
        'PROPERTY_NOT_FOUND',
        'Khu trọ không tồn tại hoặc bạn không có quyền truy cập',
      );
    }

    const { items, totalItems, summary } =
      await RoomManagementRepository.findLandlordRooms(propertyId, query);

    const totalPages =
      totalItems === 0 ? 0 : Math.ceil(totalItems / query.pageSize);

    return {
      items: items.map(mapToLandlordRoomItem),
      page: query.page,
      pageSize: query.pageSize,
      totalItems,
      totalPages,
      summary,
    };
  }

  /**
   * ROOM-03: Lấy chi tiết toàn diện phòng trọ để chủ trọ quản lý
   */
  public static async getLandlordRoomDetail(
    landlordId: string,
    roomId: string,
  ): Promise<LandlordRoomDetailResponse> {
    const room = await RoomManagementRepository.findLandlordRoomById(roomId);

    if (!room || room.property.landlordId !== landlordId) {
      throw new ApiError(
        404,
        'ROOM_NOT_FOUND',
        'Phòng trọ không tồn tại hoặc bạn không có quyền truy cập',
      );
    }

    return mapToLandlordRoomDetail(room);
  }

  /**
   * ROOM-04: Cập nhật thông tin phòng, tiện ích và phí dịch vụ (Full Replace)
   */
  public static async updateRoom(
    landlordId: string,
    roomId: string,
    input: UpdateRoomInput,
  ): Promise<LandlordRoomDetailResponse> {
    // 1. Kiểm tra phòng tồn tại và thuộc quyền sở hữu của chủ trọ
    const existingRoom = await RoomManagementRepository.findLandlordRoomById(roomId);
    if (!existingRoom || existingRoom.property.landlordId !== landlordId) {
      throw new ApiError(
        404,
        'ROOM_NOT_FOUND',
        'Phòng trọ không tồn tại hoặc bạn không có quyền truy cập',
      );
    }

    // 2. Kiểm tra trùng mã phòng trong khu trọ (loại trừ chính phòng này)
    const isDuplicate = await RoomManagementRepository.checkDuplicateRoomCode(
      existingRoom.propertyId,
      input.roomCode,
      roomId,
    );
    if (isDuplicate) {
      throw new ApiError(
        409,
        'ROOM_CODE_ALREADY_EXISTS',
        'Mã phòng đã tồn tại trong khu trọ này',
      );
    }

    // 3. Kiểm tra tính hợp lệ của danh mục tiện ích mới
    if (input.amenityIds && input.amenityIds.length > 0) {
      const areAmenitiesValid = await RoomManagementRepository.validateAmenityIds(
        input.amenityIds,
      );
      if (!areAmenitiesValid) {
        throw new ApiError(
          400,
          'VALIDATION_ERROR',
          'Một hoặc nhiều tiện ích không tồn tại hoặc không phù hợp với phòng trọ',
          { amenityIds: ['Tiện ích không hợp lệ hoặc không thuộc phạm vi phòng'] },
        );
      }
    }

    // 4. Cập nhật Full Replace trong transaction qua Repository
    const updatedRoom = await RoomManagementRepository.updateRoomTransaction(
      roomId,
      input,
    );

    return mapToLandlordRoomDetail(updatedRoom);
  }

  /**
   * ROOM-05: Chuyển đổi trạng thái vận hành phòng (VACANT ↔ MAINTENANCE)
   */
  public static async updateOperationalStatus(
    landlordId: string,
    roomId: string,
    input: UpdateOperationalStatusInput,
  ): Promise<LandlordRoomDetailResponse> {
    // 1. Kiểm tra phòng tồn tại và thuộc quyền sở hữu
    const room = await RoomManagementRepository.findLandlordRoomById(roomId);
    if (!room || room.property.landlordId !== landlordId) {
      throw new ApiError(
        404,
        'ROOM_NOT_FOUND',
        'Phòng trọ không tồn tại hoặc bạn không có quyền truy cập',
      );
    }

    const targetStatus = input.occupancyStatus;

    // 2. Cấm chuyển sang HELD hoặc RENTED (hệ thống từ chối với 409 Conflict)
    if ((targetStatus as string) === 'HELD' || (targetStatus as string) === 'RENTED') {
      throw new ApiError(
        409,
        'INVALID_STATUS_TRANSITION',
        'Chủ trọ không được phép tự chuyển trạng thái phòng sang HELD hoặc RENTED',
      );
    }

    // 3. Xử lý chuyển sang MAINTENANCE
    if (targetStatus === 'MAINTENANCE') {
      // Chặn cứng: Kiểm tra hợp đồng hiệu lực hoặc yêu cầu thuê đang xử lý
      const hasActiveContractsOrRequests =
        await RoomManagementRepository.checkActiveContractsOrRequests(roomId);
      if (hasActiveContractsOrRequests) {
        throw new ApiError(
          409,
          'CANNOT_MAINTAIN_ACTIVE_ROOM',
          'Không thể chuyển sang bảo trì khi phòng đang có hợp đồng hoặc yêu cầu thuê có hiệu lực',
        );
      }

      // Side-effect: Tự động hạ visibilityStatus về HIDDEN
      const updatedRoom = await RoomManagementRepository.updateOperationalStatus(
        roomId,
        'MAINTENANCE',
        'HIDDEN',
      );
      return mapToLandlordRoomDetail(updatedRoom);
    }

    // 4. Xử lý chuyển sang VACANT: Cho phép khi hoàn tất bảo trì, giữ nguyên visibilityStatus hiện tại
    const updatedRoom = await RoomManagementRepository.updateOperationalStatus(
      roomId,
      'VACANT',
    );
    return mapToLandlordRoomDetail(updatedRoom);
  }

  /**
   * ROOM-06: Bật/Tắt hiển thị công khai phòng trọ (visibilityStatus)
   */
  public static async updateVisibility(
    landlordId: string,
    roomId: string,
    input: UpdateVisibilityInput,
  ): Promise<LandlordRoomDetailResponse> {
    // 1. Kiểm tra phòng tồn tại và thuộc quyền sở hữu
    const room = await RoomManagementRepository.findLandlordRoomById(roomId);
    if (!room || room.property.landlordId !== landlordId) {
      throw new ApiError(
        404,
        'ROOM_NOT_FOUND',
        'Phòng trọ không tồn tại hoặc bạn không có quyền truy cập',
      );
    }

    // 2. Tắt hiển thị (HIDDEN): Luôn cho phép bất kỳ lúc nào
    if (input.visibilityStatus === 'HIDDEN') {
      const updatedRoom = await RoomManagementRepository.updateVisibility(
        roomId,
        'HIDDEN',
      );
      return mapToLandlordRoomDetail(updatedRoom);
    }

    // 3. Bật hiển thị (VISIBLE): Ràng buộc nghiêm ngặt 5 điều kiện Phase 1
    if (room.occupancyStatus !== 'VACANT') {
      throw new ApiError(
        409,
        'CANNOT_PUBLISH_ROOM',
        'Không thể bật hiển thị phòng khi phòng không ở trạng thái VACANT (còn trống)',
      );
    }

    if (room.isArchived) {
      throw new ApiError(
        409,
        'CANNOT_PUBLISH_ROOM',
        'Không thể bật hiển thị phòng đã bị lưu trữ/xóa mềm',
      );
    }

    if (room.property.status !== 'ACTIVE') {
      throw new ApiError(
        409,
        'CANNOT_PUBLISH_ROOM',
        'Không thể bật hiển thị phòng khi khu trọ chưa được kích hoạt hoặc đang bị tạm dừng',
      );
    }

    if (room.property.landlord.accountStatus !== 'ACTIVE') {
      throw new ApiError(
        409,
        'CANNOT_PUBLISH_ROOM',
        'Không thể bật hiển thị phòng khi tài khoản chủ trọ chưa được kích hoạt hoặc đang bị khóa',
      );
    }

    const updatedRoom = await RoomManagementRepository.updateVisibility(
      roomId,
      'VISIBLE',
    );
    return mapToLandlordRoomDetail(updatedRoom);
  }
}
