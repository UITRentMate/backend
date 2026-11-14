import { Router } from 'express';
import { requireAuth } from '../../common/require-auth';
import { requireRole } from '../../common/middleware/require-role';
import { PropertyController } from './property.controller';

export const propertyRouter = Router();

// ==========================================
// LANDLORD PROPERTY MANAGEMENT ROUTES (P0 & P1)
// ==========================================

// PROP-01: Tạo mới khu trọ
propertyRouter.post(
  '/api/v1/landlord/properties',
  requireAuth,
  requireRole('LANDLORD'),
  PropertyController.createProperty,
);

// PROP-02: Lấy danh sách khu trọ của chủ trọ hiện tại
propertyRouter.get(
  '/api/v1/landlord/properties',
  requireAuth,
  requireRole('LANDLORD'),
  PropertyController.getLandlordProperties,
);

// PROP-03: Chi tiết khu trọ để quản lý
propertyRouter.get(
  '/api/v1/landlord/properties/:propertyId',
  requireAuth,
  requireRole('LANDLORD'),
  PropertyController.getLandlordPropertyDetail,
);

// PROP-04: Cập nhật thông tin khu trọ (P1)
propertyRouter.put(
  '/api/v1/landlord/properties/:propertyId',
  requireAuth,
  requireRole('LANDLORD'),
  PropertyController.updateProperty,
);

// PROP-05: Lưu trữ khu trọ (P1)
propertyRouter.patch(
  '/api/v1/landlord/properties/:propertyId/archive',
  requireAuth,
  requireRole('LANDLORD'),
  PropertyController.archiveProperty,
);

// ==========================================
// PUBLIC PROPERTY ROUTES
// ==========================================

// Xem chi tiết khu trọ công khai (kèm danh sách phòng trống thỏa điều kiện Room Discovery)
propertyRouter.get(
  '/api/v1/properties/:propertyId',
  PropertyController.getPublicPropertyDetail,
);
