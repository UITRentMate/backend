import { type Request, type Response, type NextFunction } from 'express';
import { RoomService } from './room.service';
import { validateSearchRoomsQuery, validateRoomId } from './room.validation';

export class RoomController {
  /**
   * GET /api/v1/rooms/search
   */
  public static async searchRooms(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const validatedQuery = validateSearchRoomsQuery(req.query);
      const result = await RoomService.searchRooms(validatedQuery);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/public/rooms/:roomId
   */
  public static async getPublicRoomDetail(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const validatedRoomId = validateRoomId(req.params.roomId);
      const result = await RoomService.getPublicRoomDetail(validatedRoomId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
}
