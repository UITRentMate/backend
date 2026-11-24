import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser } from '../../common/middleware/require-role';
import { ResidentService } from './resident.service';
import {
  validateContractId,
  validateCreateInvitationBody,
  validateInvitationId,
  validateInvitationListQuery,
  validateUserId,
} from './resident.validation';

function requireCurrentUser(res: Response): CurrentUser {
  const currentUser = res.locals.currentUser;
  if (!currentUser) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Cần access token');
  }
  return currentUser;
}

export class ResidentController {
  public static async getContractResidents(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const currentUser = requireCurrentUser(res);
      const contractId = validateContractId(req.params.contractId);
      const result = await ResidentService.getContractResidents(contractId, currentUser);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  public static async createInvitation(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const currentUser = requireCurrentUser(res);
      const contractId = validateContractId(req.params.contractId);
      const identifier = validateCreateInvitationBody(req.body);
      const result = await ResidentService.createInvitation(contractId, identifier, currentUser);
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }

  public static async listMyInvitations(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const currentUser = requireCurrentUser(res);
      const query = validateInvitationListQuery(req.query);
      const result = await ResidentService.listMyInvitations(query, currentUser);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  public static async acceptInvitation(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const currentUser = requireCurrentUser(res);
      const invitationId = validateInvitationId(req.params.invitationId);
      const result = await ResidentService.acceptInvitation(invitationId, currentUser);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  public static async rejectInvitation(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const currentUser = requireCurrentUser(res);
      const invitationId = validateInvitationId(req.params.invitationId);
      const result = await ResidentService.rejectInvitation(invitationId, currentUser);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  public static async cancelInvitation(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const currentUser = requireCurrentUser(res);
      const invitationId = validateInvitationId(req.params.invitationId);
      const result = await ResidentService.cancelInvitation(invitationId, currentUser);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  public static async removeResident(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const currentUser = requireCurrentUser(res);
      const contractId = validateContractId(req.params.contractId);
      const targetUserId = validateUserId(req.params.userId);
      const result = await ResidentService.removeResident(contractId, targetUserId, currentUser);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
}
