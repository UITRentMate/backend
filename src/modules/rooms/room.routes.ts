import { Router } from 'express';
import { RoomController } from './room.controller';

export const roomRouter = Router();

// SEARCH-01: Tìm kiếm & lọc phòng trọ công khai
roomRouter.get('/api/v1/rooms/search', RoomController.searchRooms);

// SEARCH-02: Xem chi tiết phòng trọ công khai
roomRouter.get('/api/v1/public/rooms/:roomId', RoomController.getPublicRoomDetail);
