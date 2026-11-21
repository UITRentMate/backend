import { Router } from 'express';
import { requireAuth } from '../../common/require-auth';
import { requireRole } from '../../common/middleware/require-role';
import { RentalRequestController } from './rental-request.controller';

export const rentalRequestRouter = Router();

// ==========================================
// RENTAL REQUEST ROUTES (Issue #19 / BE-P2-06)
// ==========================================

// RENT-01: Gửi yêu cầu thuê phòng công khai (Actor: TENANT)
rentalRequestRouter.post(
  '/api/v1/rental-requests',
  requireAuth,
  requireRole('TENANT'),
  RentalRequestController.createRentalRequest,
);

// RENT-02: Xem danh sách yêu cầu thuê của mình hoặc phòng mình quản lý (Actor: TENANT, LANDLORD)
rentalRequestRouter.get(
  '/api/v1/rental-requests',
  requireAuth,
  requireRole('TENANT', 'LANDLORD'),
  RentalRequestController.getRentalRequests,
);

// RENT-03: Xem chi tiết yêu cầu thuê (Actor: TENANT, LANDLORD)
rentalRequestRouter.get(
  '/api/v1/rental-requests/:requestId',
  requireAuth,
  requireRole('TENANT', 'LANDLORD'),
  RentalRequestController.getRentalRequestDetail,
);

// RENT-05: Từ chối yêu cầu thuê PENDING kèm lý do (Actor: LANDLORD)
rentalRequestRouter.patch(
  '/api/v1/rental-requests/:requestId/reject',
  requireAuth,
  requireRole('LANDLORD'),
  RentalRequestController.rejectRentalRequest,
);
