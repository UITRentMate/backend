import { randomUUID } from 'node:crypto';
import { ApiError } from '../../common/errors/api-error';
import { RoomManagementRepository } from './room-management.repository';
import {
  buildRoomImagePublicId,
  extractCloudinaryPublicId,
  validateImageBufferMagicBytes,
} from '../../common/utils/cloudinary.util';
import { mediaService } from '../media/media.service';
import type {
  BatchUploadFailureItem,
  BatchUploadResponse,
  BatchUploadSuccessItem,
} from '../media/media.types';
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

    const currentStatus = room.occupancyStatus;
    const targetStatus = input.occupancyStatus;

    // 2. Nếu trạng thái mục tiêu giống trạng thái hiện tại -> Idempotent, trả về thông tin phòng hiện tại
    if (currentStatus === targetStatus) {
      return mapToLandlordRoomDetail(room);
    }

    // 3. Cấm chuyển sang HELD hoặc RENTED (hệ thống từ chối với 409 Conflict)
    if ((targetStatus as string) === 'HELD' || (targetStatus as string) === 'RENTED') {
      throw new ApiError(
        409,
        'INVALID_STATUS_TRANSITION',
        'Chủ trọ không được phép tự chuyển trạng thái phòng sang HELD hoặc RENTED',
      );
    }

    // 4. Ràng buộc nghiêm ngặt State Machine (§3.1):
    // Chủ trọ chỉ được phép chuyển đổi hai chiều giữa VACANT <-> MAINTENANCE.
    // Phòng đang RENTED hoặc HELD không được phép chuyển đổi thủ công
    if (currentStatus === 'HELD' || currentStatus === 'RENTED') {
      throw new ApiError(
        409,
        'INVALID_STATUS_TRANSITION',
        `Không thể chuyển đổi trạng thái thủ công khi phòng đang ở trạng thái ${currentStatus}`,
      );
    }

    // 5. Xử lý chuyển sang MAINTENANCE (chỉ được phép khi phòng đang VACANT)
    if (targetStatus === 'MAINTENANCE') {
      if (currentStatus !== 'VACANT') {
        throw new ApiError(
          409,
          'INVALID_STATUS_TRANSITION',
          'Chỉ có thể chuyển sang bảo trì từ phòng còn trống (VACANT)',
        );
      }

      // Thực thi atomic blocker check & status update trong transaction an toàn
      const updatedRoom =
        await RoomManagementRepository.transitionToMaintenanceTransaction(roomId);
      return mapToLandlordRoomDetail(updatedRoom);
    }

    // 6. Xử lý chuyển sang VACANT (chỉ được phép khi hoàn tất bảo trì từ phòng đang MAINTENANCE)
    if (targetStatus === 'VACANT') {
      if (currentStatus !== 'MAINTENANCE') {
        throw new ApiError(
          409,
          'INVALID_STATUS_TRANSITION',
          'Chỉ có thể chuyển về trạng thái VACANT từ phòng đang bảo trì (MAINTENANCE)',
        );
      }

      const updatedRoom =
        await RoomManagementRepository.transitionToVacantTransaction(roomId);
      return mapToLandlordRoomDetail(updatedRoom);
    }

    throw new ApiError(
      409,
      'INVALID_STATUS_TRANSITION',
      `Trạng thái mục tiêu ${targetStatus} không hợp lệ`,
    );
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
    // Điều kiện 1: Phòng phải còn trống (VACANT)
    if (room.occupancyStatus !== 'VACANT') {
      throw new ApiError(
        409,
        'CANNOT_PUBLISH_ROOM',
        'Không thể bật hiển thị phòng khi phòng không ở trạng thái VACANT (còn trống)',
      );
    }

    // Điều kiện 2: Phòng chưa bị lưu trữ/xóa mềm
    if (room.isArchived) {
      throw new ApiError(
        409,
        'CANNOT_PUBLISH_ROOM',
        'Không thể bật hiển thị phòng đã bị lưu trữ/xóa mềm',
      );
    }

    // Điều kiện 3: Khu trọ đang ở trạng thái hoạt động (ACTIVE)
    if (room.property.status !== 'ACTIVE') {
      throw new ApiError(
        409,
        'CANNOT_PUBLISH_ROOM',
        'Không thể bật hiển thị phòng khi khu trọ chưa được kích hoạt hoặc đang bị tạm dừng',
      );
    }

    // Điều kiện 4: Tài khoản chủ trọ đang ở trạng thái hoạt động (ACTIVE)
    if (room.property.landlord.accountStatus !== 'ACTIVE') {
      throw new ApiError(
        409,
        'CANNOT_PUBLISH_ROOM',
        'Không thể bật hiển thị phòng khi tài khoản chủ trọ chưa được kích hoạt hoặc đang bị khóa',
      );
    }

    // Điều kiện 5 [DEFERRED - Ghi chú đặc tả §3.2]: Admin áp dụng khóa hiển thị phòng.
    // Hiện tại schema CSDL (PostgreSQL / Prisma schema Phase 2) chưa có cột adminLock / moderation trên bảng rooms.
    // Ràng buộc này được ghi nhận DEFERRED và sẽ được kích hoạt khi phát triển Module Quản trị viên (Admin Moderation).

    const updatedRoom = await RoomManagementRepository.updateVisibility(
      roomId,
      'VISIBLE',
    );
    return mapToLandlordRoomDetail(updatedRoom);
  }

  /**
   * Tải bộ ảnh phòng trọ lên Cloudinary với cơ chế Partial Success
   */
  public static async uploadRoomImages(
    landlordId: string,
    roomId: string,
    files: Express.Multer.File[],
  ): Promise<{ statusCode: number; payload: BatchUploadResponse }> {
    const isOwner = await RoomManagementRepository.checkRoomOwnership(roomId, landlordId);
    if (!isOwner) {
      throw new ApiError(
        404,
        'ROOM_NOT_FOUND',
        'Phòng trọ không tồn tại hoặc bạn không có quyền truy cập',
      );
    }

    const currentCount = await RoomManagementRepository.countRoomImages(roomId);
    if (currentCount >= 10) {
      throw new ApiError(
        400,
        'ROOM_IMAGE_LIMIT_EXCEEDED',
        'Phòng trọ đã đạt giới hạn tối đa 10 ảnh',
      );
    }

    const remainingSlots = 10 - currentCount;
    const filesToProcess = files.slice(0, remainingSlots);

    const uploaded: BatchUploadSuccessItem[] = [];
    const failed: BatchUploadFailureItem[] = [];

    // Các file vượt quá remainingSlots sẽ bị đánh dấu failed ngay lập tức
    for (let i = remainingSlots; i < files.length; i++) {
      failed.push({
        index: i,
        originalName: files[i].originalname,
        size: files[i].size,
        code: 'ROOM_IMAGE_LIMIT_EXCEEDED',
        message: 'Vượt quá giới hạn tối đa 10 ảnh của phòng trọ',
      });
    }

    let currentSortOrder = await RoomManagementRepository.getMaxRoomImageSortOrder(roomId);

    for (let i = 0; i < filesToProcess.length; i++) {
      const file = filesToProcess[i];

      // Kiểm tra magic bytes
      const magicCheck = validateImageBufferMagicBytes(file.buffer);
      if (!magicCheck.valid) {
        failed.push({
          index: i,
          originalName: file.originalname,
          size: file.size,
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'Định dạng file không hợp lệ hoặc bị giả mạo. Chỉ chấp nhận JPEG, PNG, WebP',
        });
        continue;
      }

      const imageId = randomUUID();
      const publicId = buildRoomImagePublicId(roomId, imageId);

      // Stream upload lên Cloudinary
      let uploadResult;
      try {
        uploadResult = await mediaService.uploadStream(file.buffer, { publicId });
      } catch (uploadError: any) {
        failed.push({
          index: i,
          originalName: file.originalname,
          size: file.size,
          code: 'CLOUDINARY_UPLOAD_FAILED',
          message: uploadError?.message || 'Lỗi tải ảnh lên Cloudinary',
        });
        continue;
      }

      // Lưu vào database
      currentSortOrder++;
      try {
        const createdImage = await RoomManagementRepository.createRoomImage({
          id: imageId,
          roomId,
          imageUrl: uploadResult.secureUrl,
          sortOrder: currentSortOrder,
        });

        uploaded.push({
          index: i,
          originalName: file.originalname,
          size: file.size,
          id: createdImage.id,
          url: createdImage.imageUrl,
          publicId: uploadResult.publicId,
          sortOrder: createdImage.sortOrder,
        });
      } catch (dbError: any) {
        // Bù trừ: Xóa ảnh trên Cloudinary nếu DB insert lỗi
        await mediaService.deleteResource(uploadResult.publicId);
        currentSortOrder--;
        failed.push({
          index: i,
          originalName: file.originalname,
          size: file.size,
          code: 'DB_INSERT_FAILED',
          message: dbError?.message || 'Lỗi lưu thông tin ảnh vào cơ sở dữ liệu',
        });
      }
    }

    const payload: BatchUploadResponse = {
      success: uploaded.length > 0,
      summary: {
        totalRequested: files.length,
        succeeded: uploaded.length,
        failed: failed.length,
        remainingSlots: Math.max(0, 10 - (currentCount + uploaded.length)),
      },
      uploaded,
      failed,
    };

    const statusCode = uploaded.length === 0 ? 400 : uploaded.length === files.length ? 201 : 200;
    return { statusCode, payload };
  }

  /**
   * Xóa ảnh phòng trọ an toàn khỏi Database và Cloudinary
   * Coi Database là nguồn chân lý (Source of Truth): nếu Cloudinary lỗi vẫn trả về 200 OK
   */
  public static async deleteRoomImage(
    landlordId: string,
    roomId: string,
    imageId: string,
  ): Promise<{ success: true; message: string }> {
    const isOwner = await RoomManagementRepository.checkRoomOwnership(roomId, landlordId);
    if (!isOwner) {
      throw new ApiError(
        404,
        'ROOM_NOT_FOUND',
        'Phòng trọ không tồn tại hoặc bạn không có quyền truy cập',
      );
    }

    const image = await RoomManagementRepository.findRoomImageById(roomId, imageId);
    if (!image) {
      throw new ApiError(
        404,
        'IMAGE_NOT_FOUND',
        'Ảnh không tồn tại trong phòng trọ này',
      );
    }

    // Xóa trong DB trước
    await RoomManagementRepository.deleteRoomImage(imageId);

    // Xóa trên Cloudinary
    const publicId = extractCloudinaryPublicId(image.imageUrl);
    if (publicId) {
      mediaService.deleteResource(publicId).catch((err) => {
        console.warn(`[RoomManagementService] Failed to delete Cloudinary resource ${publicId}:`, err);
      });
    }

    return {
      success: true,
      message: 'Xóa ảnh phòng trọ thành công',
    };
  }
}
