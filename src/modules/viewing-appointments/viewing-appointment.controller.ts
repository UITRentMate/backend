import type { Request, Response, NextFunction } from 'express';
import { ViewingAppointmentService } from './viewing-appointment.service';
import {
  validateCreateViewingAppointment,
  validateConfirmViewingAppointment,
  validateRejectViewingAppointment,
  validateCancelViewingAppointment,
  validateAppointmentId,
  validateViewingAppointmentListQuery,
} from './viewing-appointment.validation';

export class ViewingAppointmentController {
  /**
   * POST /api/v1/viewing-appointments (VIEW-01)
   */
  public static async createAppointment(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const tenantId = res.locals.userId as string;
      const input = validateCreateViewingAppointment(req.body);
      const result = await ViewingAppointmentService.createAppointment(tenantId, input);
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/viewing-appointments (VIEW-02)
   */
  public static async getViewingAppointments(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const user = res.locals.currentUser ?? {
        id: res.locals.userId as string,
        role: 'TENANT',
      };
      const query = validateViewingAppointmentListQuery(req.query);
      const result = await ViewingAppointmentService.getAppointmentList(user, query);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/viewing-appointments/:appointmentId (VIEW-03)
   */
  public static async getViewingAppointmentDetail(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const user = res.locals.currentUser ?? {
        id: res.locals.userId as string,
        role: 'TENANT',
      };
      const appointmentId = validateAppointmentId(req.params.appointmentId);
      const result = await ViewingAppointmentService.getAppointmentDetail(user, appointmentId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/v1/viewing-appointments/:appointmentId/confirm (VIEW-04)
   */
  public static async confirmAppointment(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const landlordId = res.locals.userId as string;
      const appointmentId = validateAppointmentId(req.params.appointmentId);
      const input = validateConfirmViewingAppointment(req.body);
      const result = await ViewingAppointmentService.confirmAppointment(
        landlordId,
        appointmentId,
        input,
      );
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/v1/viewing-appointments/:appointmentId/reject (VIEW-06)
   */
  public static async rejectAppointment(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const landlordId = res.locals.userId as string;
      const appointmentId = validateAppointmentId(req.params.appointmentId);
      const input = validateRejectViewingAppointment(req.body);
      const result = await ViewingAppointmentService.rejectAppointment(
        landlordId,
        appointmentId,
        input,
      );
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/v1/viewing-appointments/:appointmentId/cancel (VIEW-07)
   */
  public static async cancelAppointment(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const user = res.locals.currentUser ?? {
        id: res.locals.userId as string,
        role: 'TENANT',
      };
      const appointmentId = validateAppointmentId(req.params.appointmentId);
      const input = validateCancelViewingAppointment(req.body);
      const result = await ViewingAppointmentService.cancelAppointment(
        user,
        appointmentId,
        input,
      );
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
}
