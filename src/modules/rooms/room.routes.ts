import { Router } from 'express';
import { requireRole } from '../../common/middleware/require-role';
import { uploadMultipleImages } from '../media/media.middleware';
import { RoomController } from './room.controller';
import { RoomManagementController } from './room-management.controller';

export const roomRouter = Router();

// ==========================================
// PUBLIC ROOM DISCOVERY ROUTES
// ==========================================

// 1. SEARCH-01: Tìm kiếm & lọc phòng trọ công khai (BẮT BUỘC ĐĂNG KÝ TRƯỚC /:roomId)
roomRouter.get('/api/v1/rooms/search', RoomController.searchRooms);

// 2. SEARCH-02: Xem chi tiết phòng công khai (URL Canonical)
roomRouter.get('/api/v1/rooms/:roomId', RoomController.getPublicRoomDetail);

// 3. SEARCH-02 Alias: Xem chi tiết phòng công khai (Deprecated Alias)
roomRouter.get('/api/v1/public/rooms/:roomId', RoomController.getPublicRoomDetail);

// ==========================================
// LANDLORD ROOM MANAGEMENT ROUTES (P2-02)
// ==========================================

// ROOM-01: Tạo phòng trọ mới kèm tiện ích và phí dịch vụ
roomRouter.post(
  '/api/v1/landlord/properties/:propertyId/rooms',
  requireRole('LANDLORD'),
  RoomManagementController.createRoom,
);

// ROOM-02: Lấy danh sách phòng thuộc khu trọ kèm phân trang và summary counters
roomRouter.get(
  '/api/v1/landlord/properties/:propertyId/rooms',
  requireRole('LANDLORD'),
  RoomManagementController.getLandlordRooms,
);

// ROOM-03: Chi tiết phòng quản lý của chủ trọ
roomRouter.get(
  '/api/v1/landlord/rooms/:roomId',
  requireRole('LANDLORD'),
  RoomManagementController.getLandlordRoomDetail,
);

// ROOM-04: Cập nhật thông tin phòng, tiện ích và phí dịch vụ (Full Replace)
roomRouter.put(
  '/api/v1/landlord/rooms/:roomId',
  requireRole('LANDLORD'),
  RoomManagementController.updateRoom,
);

// ROOM-05: Chuyển đổi trạng thái vận hành phòng (VACANT <-> MAINTENANCE)
roomRouter.patch(
  '/api/v1/landlord/rooms/:roomId/operational-status',
  requireRole('LANDLORD'),
  RoomManagementController.updateOperationalStatus,
);

// ROOM-06: Bật/Tắt hiển thị công khai phòng trọ
roomRouter.patch(
  '/api/v1/landlord/rooms/:roomId/visibility',
  requireRole('LANDLORD'),
  RoomManagementController.updateVisibility,
);

// ROOM-07: Tải bộ ảnh phòng trọ lên Cloudinary (P2-03)
roomRouter.post(
  '/api/v1/landlord/rooms/:roomId/images',
  requireRole('LANDLORD'),
  uploadMultipleImages('images', 10),
  RoomManagementController.uploadRoomImages,
);
