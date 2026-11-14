import type { Request, Response, NextFunction } from 'express';
import { RentalRequestService } from './rental-request.service';
import {
  validateCreateRentalRequest,
  validateRejectRentalRequest,
  validateRentalRequestFilterQuery,
  validateRentalRequestId,
} from './rental-request.validation';

export class RentalRequestController {
  /**
   * POST /api/v1/rental-requests
   * RENT-01: Gửi yêu cầu thuê phòng
   */
  public static async createRentalRequest(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const tenantId = res.locals.userId as string;
      const input = validateCreateRentalRequest(req.body);
      const result = await RentalRequestService.createRentalRequest(tenantId, input);
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/rental-requests
   * RENT-02: Danh sách yêu cầu thuê
   */
  public static async getRentalRequests(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const currentUser = res.locals.currentUser ?? {
        id: res.locals.userId as string,
        role: (req as any).user?.role ?? 'TENANT',
      };
      const query = validateRentalRequestFilterQuery(req.query);
      const result = await RentalRequestService.getRentalRequests(currentUser, query);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/rental-requests/:requestId
   * RENT-03: Chi tiết yêu cầu thuê
   */
  public static async getRentalRequestDetail(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const currentUser = res.locals.currentUser ?? {
        id: res.locals.userId as string,
        role: (req as any).user?.role ?? 'TENANT',
      };
      const requestId = validateRentalRequestId(req.params.requestId);
      const result = await RentalRequestService.getRentalRequestDetail(currentUser, requestId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/v1/rental-requests/:requestId/reject
   * RENT-05: Từ chối yêu cầu thuê
   */
  public static async rejectRentalRequest(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const landlordId = res.locals.userId as string;
      const requestId = validateRentalRequestId(req.params.requestId);
      const input = validateRejectRentalRequest(req.body);
      const result = await RentalRequestService.rejectRentalRequest(
        landlordId,
        requestId,
        input,
      );
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
}
