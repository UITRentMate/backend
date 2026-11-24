import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../../common/errors/api-error';
import { RentalRequestService } from './rental-request.service';
import {
  validateCreateRentalRequest,
  validateRejectRentalRequest,
  validateRentalRequestFilterQuery,
  validateRentalRequestId,
} from './rental-request.validation';

function requireCurrentUser(res: Response) {
  const currentUser = res.locals.currentUser;
  if (!currentUser) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Cần xác thực người dùng');
  }
  return currentUser;
}

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
      const tenantId = requireCurrentUser(res).id;
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
      const currentUser = requireCurrentUser(res);
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
      const currentUser = requireCurrentUser(res);
      const requestId = validateRentalRequestId(req.params.requestId);
      const result = await RentalRequestService.getRentalRequestDetail(currentUser, requestId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  public static async approveRentalRequest(req: Request, res: Response): Promise<void> {
    const landlordId = requireCurrentUser(res).id;
    const requestId = validateRentalRequestId(req.params.requestId);
    res.status(200).json(await RentalRequestService.approveRentalRequest(landlordId, requestId));
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
      const landlordId = requireCurrentUser(res).id;
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
