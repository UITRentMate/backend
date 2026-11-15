import type { Request, Response, NextFunction } from 'express';
import { RoomManagementService } from './room-management.service';
import {
  validateCreateRoom,
  validateUpdateRoom,
  validateUpdateOperationalStatus,
  validateUpdateVisibility,
  validateLandlordRoomListQuery,
  validateRoomId,
  validatePropertyId,
} from './room-management.validation';

export class RoomManagementController {
  /**
   * POST /api/v1/landlord/properties/:propertyId/rooms
   * ROOM-01: Tạo phòng trọ mới kèm tiện ích và phí dịch vụ
   */
  public static async createRoom(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const landlordId = (res.locals.currentUser?.id ?? res.locals.userId) as string;
      const propertyId = validatePropertyId(req.params.propertyId);
      const input = validateCreateRoom(req.body);
      const result = await RoomManagementService.createRoom(landlordId, propertyId, input);
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/landlord/properties/:propertyId/rooms
   * ROOM-02: Lấy danh sách phòng thuộc khu trọ kèm phân trang và summary counters
   */
  public static async getLandlordRooms(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const landlordId = (res.locals.currentUser?.id ?? res.locals.userId) as string;
      const propertyId = validatePropertyId(req.params.propertyId);
      const query = validateLandlordRoomListQuery(req.query);
      const result = await RoomManagementService.getLandlordRooms(landlordId, propertyId, query);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/landlord/rooms/:roomId
   * ROOM-03: Chi tiết phòng quản lý của chủ trọ
   */
  public static async getLandlordRoomDetail(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const landlordId = (res.locals.currentUser?.id ?? res.locals.userId) as string;
      const roomId = validateRoomId(req.params.roomId);
      const result = await RoomManagementService.getLandlordRoomDetail(landlordId, roomId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/v1/landlord/rooms/:roomId
   * ROOM-04: Cập nhật thông tin phòng, tiện ích và phí dịch vụ (Full Replace)
   */
  public static async updateRoom(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const landlordId = (res.locals.currentUser?.id ?? res.locals.userId) as string;
      const roomId = validateRoomId(req.params.roomId);
      const input = validateUpdateRoom(req.body);
      const result = await RoomManagementService.updateRoom(landlordId, roomId, input);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/v1/landlord/rooms/:roomId/operational-status
   * ROOM-05: Chuyển đổi trạng thái vận hành phòng (VACANT <-> MAINTENANCE)
   */
  public static async updateOperationalStatus(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const landlordId = (res.locals.currentUser?.id ?? res.locals.userId) as string;
      const roomId = validateRoomId(req.params.roomId);
      const input = validateUpdateOperationalStatus(req.body);
      const result = await RoomManagementService.updateOperationalStatus(
        landlordId,
        roomId,
        input,
      );
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/v1/landlord/rooms/:roomId/visibility
   * ROOM-06: Bật/Tắt hiển thị công khai phòng trọ
   */
  public static async updateVisibility(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const landlordId = (res.locals.currentUser?.id ?? res.locals.userId) as string;
      const roomId = validateRoomId(req.params.roomId);
      const input = validateUpdateVisibility(req.body);
      const result = await RoomManagementService.updateVisibility(landlordId, roomId, input);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
}
