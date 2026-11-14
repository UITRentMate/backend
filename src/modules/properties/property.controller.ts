import type { Request, Response, NextFunction } from 'express';
import { PropertyService } from './property.service';
import {
  validateCreateProperty,
  validateUpdateProperty,
  validatePropertyListQuery,
  validatePropertyId,
} from './property.validation';

export class PropertyController {
  /**
   * POST /api/v1/landlord/properties
   */
  public static async createProperty(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const landlordId = res.locals.userId as string;
      const input = validateCreateProperty(req.body);
      const result = await PropertyService.createProperty(landlordId, input);
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/landlord/properties
   */
  public static async getLandlordProperties(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const landlordId = res.locals.userId as string;
      const query = validatePropertyListQuery(req.query);
      const result = await PropertyService.getLandlordProperties(landlordId, query);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/landlord/properties/:propertyId
   */
  public static async getLandlordPropertyDetail(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const landlordId = res.locals.userId as string;
      const propertyId = validatePropertyId(req.params.propertyId);
      const result = await PropertyService.getLandlordPropertyDetail(landlordId, propertyId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/v1/landlord/properties/:propertyId
   */
  public static async updateProperty(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const landlordId = res.locals.userId as string;
      const propertyId = validatePropertyId(req.params.propertyId);
      const input = validateUpdateProperty(req.body);
      const result = await PropertyService.updateProperty(landlordId, propertyId, input);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/v1/landlord/properties/:propertyId/archive
   */
  public static async archiveProperty(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const landlordId = res.locals.userId as string;
      const propertyId = validatePropertyId(req.params.propertyId);
      await PropertyService.archiveProperty(landlordId, propertyId);
      res.status(200).json({ success: true, message: 'Lưu trữ khu trọ thành công' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/properties/:propertyId
   */
  public static async getPublicPropertyDetail(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const propertyId = validatePropertyId(req.params.propertyId);
      const result = await PropertyService.getPublicPropertyDetail(propertyId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
}
