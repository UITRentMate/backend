import { ApiError } from '../../common/errors/api-error';
import {
  type SearchRoomsQuery,
  type PaginatedRoomResponse,
  type PublicRoomDetailDTO,
} from './room.types';
import { mapToRoomCardDTO, mapToPublicRoomDetailDTO } from './room.mapper';
import { RoomRepository } from './room.repository';

export class RoomService {
  /**
   * SEARCH-01: Tìm kiếm, lọc và phân trang danh sách phòng trọ công khai
   */
  public static async searchRooms(query: SearchRoomsQuery): Promise<PaginatedRoomResponse> {
    // Thực thi song song truy vấn đếm tổng số bản ghi và lấy danh sách phòng công khai qua Repository
    const [totalItems, rooms] = await Promise.all([
      RoomRepository.countPublicRooms(query),
      RoomRepository.findPublicRooms(query),
    ]);

    const items = rooms.map(mapToRoomCardDTO);
    const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / query.pageSize);

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      totalItems,
      totalPages,
    };
  }

  /**
   * SEARCH-02: Xem chi tiết toàn diện phòng trọ công khai theo roomId
   */
  public static async getPublicRoomDetail(roomId: string): Promise<PublicRoomDetailDTO> {
    const room = await RoomRepository.findPublicRoomById(roomId);

    if (!room) {
      throw new ApiError(
        404,
        'ROOM_NOT_FOUND',
        'Phòng trọ không tồn tại hoặc hiện không khả dụng công khai'
      );
    }

    // Đếm tổng số phòng vật lý chưa archived và phòng đang công khai trống bằng Repository methods
    const [totalRooms, vacantRooms] = await Promise.all([
      RoomRepository.countPropertyRooms(room.propertyId),
      RoomRepository.countPropertyVacantRooms(room.propertyId),
    ]);

    return mapToPublicRoomDetailDTO(room, totalRooms, vacantRooms);
  }
}
