import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser } from '../../common/middleware/require-role';
import { RepairTicketService } from './repair-ticket.service';
import {
  validateAcceptRepairTicketBody,
  validateCompleteRepairTicketBody,
  validateCreateRepairTicketBody,
  validateRejectRepairCompletionBody,
  validateRepairTicketListQuery,
  validateTicketId,
} from './repair-ticket.validation';

function requireCurrentUser(res: Response): CurrentUser {
  const currentUser = res.locals.currentUser;
  if (!currentUser) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Cần access token');
  }
  return currentUser;
}

export class RepairTicketController {
  public static async createRepairTicket(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const currentUser = requireCurrentUser(res);
      const input = validateCreateRepairTicketBody(req.body);
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const result = await RepairTicketService.createRepairTicket(input, files, currentUser);
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }

  public static async listRepairTickets(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const currentUser = requireCurrentUser(res);
      const query = validateRepairTicketListQuery(req.query);
      const result = await RepairTicketService.listRepairTickets(query, currentUser);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  public static async getRepairTicketDetail(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const currentUser = requireCurrentUser(res);
      const ticketId = validateTicketId(req.params.ticketId);
      const result = await RepairTicketService.getRepairTicketDetail(ticketId, currentUser);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  public static async acceptRepairTicket(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const currentUser = requireCurrentUser(res);
      const ticketId = validateTicketId(req.params.ticketId);
      const input = validateAcceptRepairTicketBody(req.body);
      const result = await RepairTicketService.acceptRepairTicket(ticketId, input, currentUser);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  public static async completeRepairTicket(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const currentUser = requireCurrentUser(res);
      const ticketId = validateTicketId(req.params.ticketId);
      const input = validateCompleteRepairTicketBody(req.body);
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const result = await RepairTicketService.completeRepairTicket(
        ticketId,
        input,
        files,
        currentUser,
      );
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  public static async confirmCompletion(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const currentUser = requireCurrentUser(res);
      const ticketId = validateTicketId(req.params.ticketId);
      const result = await RepairTicketService.confirmCompletion(ticketId, currentUser);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  public static async rejectCompletion(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const currentUser = requireCurrentUser(res);
      const ticketId = validateTicketId(req.params.ticketId);
      const input = validateRejectRepairCompletionBody(req.body);
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const result = await RepairTicketService.rejectCompletion(
        ticketId,
        input,
        files,
        currentUser,
      );
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
}
