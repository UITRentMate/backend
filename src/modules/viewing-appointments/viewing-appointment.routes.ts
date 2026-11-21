import { Router } from 'express';
import { requireAuth } from '../../common/require-auth';
import { requireRole } from '../../common/middleware/require-role';
import { ViewingAppointmentController } from './viewing-appointment.controller';

export const viewingAppointmentRouter = Router();

// ==========================================
// VIEWING APPOINTMENT ROUTES (P0 Scope)
// ==========================================

// VIEW-01: Người thuê gửi yêu cầu tạo lịch hẹn xem phòng kèm 1–3 khung giờ
viewingAppointmentRouter.post(
  '/api/v1/viewing-appointments',
  requireAuth,
  requireRole('TENANT'),
  ViewingAppointmentController.createAppointment,
);

// VIEW-02: Lấy danh sách lịch hẹn theo phân quyền Người thuê / Chủ trọ
viewingAppointmentRouter.get(
  '/api/v1/viewing-appointments',
  requireAuth,
  requireRole('TENANT', 'LANDLORD'),
  ViewingAppointmentController.getViewingAppointments,
);

// VIEW-03: Xem chi tiết một lịch hẹn xem phòng
viewingAppointmentRouter.get(
  '/api/v1/viewing-appointments/:appointmentId',
  requireAuth,
  requireRole('TENANT', 'LANDLORD'),
  ViewingAppointmentController.getViewingAppointmentDetail,
);

// VIEW-04: Chủ trọ chọn một khung giờ để xác nhận lịch hẹn
viewingAppointmentRouter.patch(
  '/api/v1/viewing-appointments/:appointmentId/confirm',
  requireAuth,
  requireRole('LANDLORD'),
  ViewingAppointmentController.confirmAppointment,
);

// VIEW-06: Chủ trọ từ chối lịch hẹn xem phòng
viewingAppointmentRouter.patch(
  '/api/v1/viewing-appointments/:appointmentId/reject',
  requireAuth,
  requireRole('LANDLORD'),
  ViewingAppointmentController.rejectAppointment,
);

// VIEW-07: Người thuê hoặc Chủ trọ hủy lịch hẹn theo quy tắc
viewingAppointmentRouter.patch(
  '/api/v1/viewing-appointments/:appointmentId/cancel',
  requireAuth,
  requireRole('TENANT', 'LANDLORD'),
  ViewingAppointmentController.cancelAppointment,
);
