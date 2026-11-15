import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { ApiError } from '../../src/common/errors/api-error';
import { prisma } from '../../src/infrastructure/database/prisma';
import { RoomManagementRepository } from '../../src/modules/rooms/room-management.repository';
import type { CreateRoomInput, UpdateRoomInput } from '../../src/modules/rooms/room-management.types';

const undo: Array<() => void> = [];
afterEach(() => {
  while (undo.length) undo.pop()!();
});

function stub(delegate: any, name: string, implementation: (...args: any[]) => any) {
  const original = delegate[name];
  delegate[name] = implementation;
  undo.push(() => {
    delegate[name] = original;
  });
}

const mockLandlordId = '550e8400-e29b-41d4-a716-446655440001';
const mockPropertyId = '550e8400-e29b-41d4-a716-446655440002';
const mockRoomId = '550e8400-e29b-41d4-a716-446655440003';
const mockAmenityId = '550e8400-e29b-41d4-a716-446655440004';

describe('RoomManagementRepository Unit Tests', () => {
  describe('checkPropertyOwnership', () => {
    test('trả về true khi khu trọ thuộc quyền sở hữu của chủ trọ', async () => {
      stub(prisma.property, 'count', async ({ where }: any) => {
        assert.equal(where.id, mockPropertyId);
        assert.equal(where.landlordId, mockLandlordId);
        return 1;
      });

      const result = await RoomManagementRepository.checkPropertyOwnership(mockPropertyId, mockLandlordId);
      assert.equal(result, true);
    });

    test('trả về false khi khu trọ không thuộc quyền sở hữu của chủ trọ', async () => {
      stub(prisma.property, 'count', async () => 0);

      const result = await RoomManagementRepository.checkPropertyOwnership(mockPropertyId, mockLandlordId);
      assert.equal(result, false);
    });
  });

  describe('checkRoomOwnership', () => {
    test('trả về true khi phòng trọ thuộc khu trọ của chủ trọ', async () => {
      stub(prisma.room, 'count', async ({ where }: any) => {
        assert.equal(where.id, mockRoomId);
        assert.equal(where.property.landlordId, mockLandlordId);
        return 1;
      });

      const result = await RoomManagementRepository.checkRoomOwnership(mockRoomId, mockLandlordId);
      assert.equal(result, true);
    });

    test('trả về false khi phòng trọ không thuộc khu trọ của chủ trọ', async () => {
      stub(prisma.room, 'count', async () => 0);

      const result = await RoomManagementRepository.checkRoomOwnership(mockRoomId, mockLandlordId);
      assert.equal(result, false);
    });
  });

  describe('checkDuplicateRoomCode', () => {
    test('trả về true khi mã phòng đã tồn tại trong khu trọ', async () => {
      stub(prisma.room, 'count', async ({ where }: any) => {
        assert.equal(where.propertyId, mockPropertyId);
        assert.equal(where.roomCode.equals, 'P.301');
        assert.equal(where.roomCode.mode, 'insensitive');
        return 1;
      });

      const result = await RoomManagementRepository.checkDuplicateRoomCode(mockPropertyId, 'P.301');
      assert.equal(result, true);
    });

    test('trả về false khi mã phòng chưa tồn tại', async () => {
      stub(prisma.room, 'count', async () => 0);

      const result = await RoomManagementRepository.checkDuplicateRoomCode(mockPropertyId, 'P.999');
      assert.equal(result, false);
    });

    test('hỗ trợ excludeRoomId khi kiểm tra trùng lặp cho thao tác update', async () => {
      stub(prisma.room, 'count', async ({ where }: any) => {
        assert.deepEqual(where.id, { not: mockRoomId });
        return 0;
      });

      const result = await RoomManagementRepository.checkDuplicateRoomCode(mockPropertyId, 'P.301', mockRoomId);
      assert.equal(result, false);
    });
  });

  describe('checkActiveContractsOrRequests', () => {
    test('trả về true nếu có hợp đồng hiệu lực (status notIn TERMINATED, CANCELLED, EXPIRED, LIQUIDATED)', async () => {
      stub(prisma.contract, 'count', async ({ where }: any) => {
        assert.deepEqual(where.status.notIn, ['TERMINATED', 'CANCELLED', 'EXPIRED', 'LIQUIDATED']);
        return 1;
      });
      stub(prisma.rentalRequest, 'count', async () => 0);

      const result = await RoomManagementRepository.checkActiveContractsOrRequests(mockRoomId);
      assert.equal(result, true);
    });

    test('trả về true nếu có yêu cầu thuê đang chờ xử lý (status in PENDING, ACCEPTED)', async () => {
      stub(prisma.contract, 'count', async () => 0);
      stub(prisma.rentalRequest, 'count', async () => 1);

      const result = await RoomManagementRepository.checkActiveContractsOrRequests(mockRoomId);
      assert.equal(result, true);
    });

    test('trả về false nếu không có hợp đồng hiệu lực lẫn yêu cầu thuê', async () => {
      stub(prisma.contract, 'count', async () => 0);
      stub(prisma.rentalRequest, 'count', async () => 0);

      const result = await RoomManagementRepository.checkActiveContractsOrRequests(mockRoomId);
      assert.equal(result, false);
    });
  });

  describe('validateAmenityIds', () => {
    test('trả về true với mảng rỗng', async () => {
      const result = await RoomManagementRepository.validateAmenityIds([]);
      assert.equal(result, true);
    });

    test('trả về true khi tất cả UUID hợp lệ và không mang scope PROPERTY', async () => {
      stub(prisma.amenity, 'count', async ({ where }: any) => {
        assert.deepEqual(where.id.in, [mockAmenityId]);
        assert.equal(where.scope.not, 'PROPERTY');
        return 1;
      });

      const result = await RoomManagementRepository.validateAmenityIds([mockAmenityId]);
      assert.equal(result, true);
    });

    test('trả về false khi số lượng tìm thấy không khớp số UUID truyền vào', async () => {
      stub(prisma.amenity, 'count', async () => 0);

      const result = await RoomManagementRepository.validateAmenityIds([mockAmenityId]);
      assert.equal(result, false);
    });
  });

  describe('createRoomTransaction', () => {
    test('ném lỗi 409 DUPLICATE_ROOM_CODE khi phát hiện trùng mã phòng trong transaction', async () => {
      const mockTx: any = {
        room: {
          count: async () => 1,
        },
      };

      stub(prisma, '$transaction', async (fn: any) => fn(mockTx));

      const input: CreateRoomInput = {
        roomCode: 'P.301',
        areaM2: 28.5,
        maxOccupants: 2,
        monthlyRent: 4500000,
        depositRequired: 4500000,
        electricityRate: 3800,
        waterRate: 25000,
      };

      await assert.rejects(
        () => RoomManagementRepository.createRoomTransaction(mockPropertyId, input),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, 'DUPLICATE_ROOM_CODE');
          return true;
        },
      );
    });

    test('tạo phòng với các giá trị mặc định VACANT, HIDDEN và các quan hệ trong transaction', async () => {
      let createdRoomData: any = null;
      let createdAmenitiesData: any = null;
      let createdFeesData: any = null;

      const mockTx: any = {
        room: {
          count: async () => 0,
          create: async ({ data }: any) => {
            createdRoomData = data;
            return { id: mockRoomId, ...data };
          },
          findUniqueOrThrow: async () => ({
            id: mockRoomId,
            propertyId: mockPropertyId,
            roomCode: 'P.301',
            occupancyStatus: 'VACANT',
            visibilityStatus: 'HIDDEN',
            isArchived: false,
            roomAmenities: [],
            serviceFees: [],
            images: [],
          }),
        },
        roomAmenity: {
          createMany: async ({ data }: any) => {
            createdAmenitiesData = data;
            return { count: data.length };
          },
        },
        roomServiceFee: {
          createMany: async ({ data }: any) => {
            createdFeesData = data;
            return { count: data.length };
          },
        },
      };

      stub(prisma, '$transaction', async (fn: any) => fn(mockTx));

      const input: CreateRoomInput = {
        roomCode: '  P.301  ',
        floor: 3,
        areaM2: 28.5,
        maxOccupants: 2,
        monthlyRent: 4500000,
        depositRequired: 4500000,
        electricityRate: 3800,
        waterRate: 25000,
        amenityIds: [mockAmenityId],
        serviceFees: [{ feeName: 'Vệ sinh', monthlyAmount: 50000, isRequired: true }],
      };

      const result = await RoomManagementRepository.createRoomTransaction(mockPropertyId, input);

      assert.equal(createdRoomData.propertyId, mockPropertyId);
      assert.equal(createdRoomData.roomCode, 'P.301');
      assert.equal(createdRoomData.occupancyStatus, 'VACANT');
      assert.equal(createdRoomData.visibilityStatus, 'HIDDEN');
      assert.equal(createdRoomData.isArchived, false);
      assert.equal(createdAmenitiesData.length, 1);
      assert.equal(createdAmenitiesData[0].amenityId, mockAmenityId);
      assert.equal(createdFeesData.length, 1);
      assert.equal(createdFeesData[0].feeName, 'Vệ sinh');
      assert.equal(result.id, mockRoomId);
    });
  });

  describe('updateRoomTransaction', () => {
    test('ném lỗi 409 DUPLICATE_ROOM_CODE khi cập nhật sang mã phòng trùng lặp trong transaction', async () => {
      const mockTx: any = {
        room: {
          findUnique: async () => ({ propertyId: mockPropertyId }),
          count: async () => 1,
        },
      };

      stub(prisma, '$transaction', async (fn: any) => fn(mockTx));

      const input: UpdateRoomInput = {
        roomCode: 'P.302-DUPLICATE',
        areaM2: 30,
        maxOccupants: 2,
        monthlyRent: 5000000,
        depositRequired: 5000000,
        electricityRate: 3800,
        waterRate: 25000,
      };

      await assert.rejects(
        () => RoomManagementRepository.updateRoomTransaction(mockRoomId, input),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, 'DUPLICATE_ROOM_CODE');
          return true;
        },
      );
    });

    test('xóa liên kết cũ và tạo mới liên kết tiện ích, phí dịch vụ (Full Replace)', async () => {
      let deletedAmenityWhere: any = null;
      let deletedFeeWhere: any = null;
      let updatedRoomData: any = null;

      const mockTx: any = {
        roomAmenity: {
          deleteMany: async ({ where }: any) => {
            deletedAmenityWhere = where;
            return { count: 1 };
          },
          createMany: async ({ data }: any) => ({ count: data.length }),
        },
        roomServiceFee: {
          deleteMany: async ({ where }: any) => {
            deletedFeeWhere = where;
            return { count: 1 };
          },
          createMany: async ({ data }: any) => ({ count: data.length }),
        },
        room: {
          findUnique: async () => ({ propertyId: mockPropertyId }),
          count: async () => 0,
          update: async ({ where, data }: any) => {
            updatedRoomData = data;
            return { id: where.id, ...data };
          },
          findUniqueOrThrow: async () => ({
            id: mockRoomId,
            roomCode: 'P.301-VIP',
            areaM2: 30,
            roomAmenities: [],
            serviceFees: [],
            images: [],
          }),
        },
      };

      stub(prisma, '$transaction', async (fn: any) => fn(mockTx));

      const input: UpdateRoomInput = {
        roomCode: 'P.301-VIP',
        floor: 3,
        areaM2: 30,
        maxOccupants: 3,
        monthlyRent: 5000000,
        depositRequired: 5000000,
        electricityRate: 3800,
        waterRate: 25000,
        amenityIds: [mockAmenityId],
        serviceFees: [{ feeName: 'Vệ sinh nâng cao', monthlyAmount: 70000, isRequired: true }],
      };

      const result = await RoomManagementRepository.updateRoomTransaction(mockRoomId, input);

      assert.deepEqual(deletedAmenityWhere, { roomId: mockRoomId });
      assert.deepEqual(deletedFeeWhere, { roomId: mockRoomId });
      assert.equal(updatedRoomData.roomCode, 'P.301-VIP');
      assert.equal(updatedRoomData.areaM2, 30);
      assert.equal(result.id, mockRoomId);
    });
  });

  describe('findLandlordRooms', () => {
    test('truy vấn danh sách phòng phân trang và tính toán summary counters song song', async () => {
      const mockRoomsSummary = [
        { occupancyStatus: 'VACANT', visibilityStatus: 'VISIBLE' },
        { occupancyStatus: 'VACANT', visibilityStatus: 'HIDDEN' },
        { occupancyStatus: 'MAINTENANCE', visibilityStatus: 'HIDDEN' },
        { occupancyStatus: 'RENTED', visibilityStatus: 'HIDDEN' },
        { occupancyStatus: 'HELD', visibilityStatus: 'HIDDEN' },
      ];

      stub(prisma.room, 'findMany', async (args: any) => {
        // Cuộc gọi thứ nhất lấy all rooms for summary
        if (args.select) {
          return mockRoomsSummary;
        }
        // Cuộc gọi thứ hai lấy paginated items
        return [
          {
            id: mockRoomId,
            roomCode: 'P.301',
            occupancyStatus: 'VACANT',
            visibilityStatus: 'VISIBLE',
            images: [],
            roomAmenities: [],
            serviceFees: [],
          },
        ];
      });

      stub(prisma.room, 'count', async () => 1);

      const result = await RoomManagementRepository.findLandlordRooms(mockPropertyId, {
        page: 1,
        pageSize: 10,
        search: 'P.301',
      });

      assert.equal(result.totalItems, 1);
      assert.equal(result.items.length, 1);
      assert.equal(result.summary.total, 5);
      assert.equal(result.summary.vacant, 2);
      assert.equal(result.summary.maintenance, 1);
      assert.equal(result.summary.rented, 1);
      assert.equal(result.summary.held, 1);
      assert.equal(result.summary.visible, 1);
      assert.equal(result.summary.hidden, 4);
    });
  });

  describe('findLandlordRoomById', () => {
    test('truy vấn phòng theo roomId kèm đầy đủ quan hệ', async () => {
      stub(prisma.room, 'findUnique', async ({ where, include }: any) => {
        assert.equal(where.id, mockRoomId);
        assert.ok(include.roomAmenities);
        assert.ok(include.serviceFees);
        assert.ok(include.images);
        assert.ok(include.property);
        return {
          id: mockRoomId,
          roomCode: 'P.301',
          property: {
            id: mockPropertyId,
            landlordId: mockLandlordId,
          },
        };
      });

      const result = await RoomManagementRepository.findLandlordRoomById(mockRoomId);
      assert.ok(result);
      assert.equal(result?.id, mockRoomId);
    });
  });

  describe('transitionToMaintenanceTransaction', () => {
    test('ném 409 CANNOT_MAINTAIN_ACTIVE_ROOM khi có hợp đồng hiệu lực trong transaction', async () => {
      const mockTx: any = {
        contract: { count: async () => 1 },
        rentalRequest: { count: async () => 0 },
      };
      stub(prisma, '$transaction', async (fn: any) => fn(mockTx));

      await assert.rejects(
        () => RoomManagementRepository.transitionToMaintenanceTransaction(mockRoomId),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, 'CANNOT_MAINTAIN_ACTIVE_ROOM');
          return true;
        },
      );
    });

    test('ném 409 CANNOT_MAINTAIN_ACTIVE_ROOM khi có yêu cầu thuê đang xử lý trong transaction', async () => {
      const mockTx: any = {
        contract: { count: async () => 0 },
        rentalRequest: { count: async () => 1 },
      };
      stub(prisma, '$transaction', async (fn: any) => fn(mockTx));

      await assert.rejects(
        () => RoomManagementRepository.transitionToMaintenanceTransaction(mockRoomId),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, 'CANNOT_MAINTAIN_ACTIVE_ROOM');
          return true;
        },
      );
    });

    test('ném 409 INVALID_STATUS_TRANSITION khi phòng không ở trạng thái VACANT (updateMany count = 0)', async () => {
      const mockTx: any = {
        contract: { count: async () => 0 },
        rentalRequest: { count: async () => 0 },
        room: {
          updateMany: async () => ({ count: 0 }),
        },
      };
      stub(prisma, '$transaction', async (fn: any) => fn(mockTx));

      await assert.rejects(
        () => RoomManagementRepository.transitionToMaintenanceTransaction(mockRoomId),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, 'INVALID_STATUS_TRANSITION');
          return true;
        },
      );
    });

    test('thành công chuyển sang MAINTENANCE và tự động hạ visibilityStatus = HIDDEN', async () => {
      let updateWhere: any = null;
      let updateData: any = null;

      const mockTx: any = {
        contract: { count: async () => 0 },
        rentalRequest: { count: async () => 0 },
        room: {
          updateMany: async ({ where, data }: any) => {
            updateWhere = where;
            updateData = data;
            return { count: 1 };
          },
          findUniqueOrThrow: async () => ({
            id: mockRoomId,
            occupancyStatus: 'MAINTENANCE',
            visibilityStatus: 'HIDDEN',
          }),
        },
      };
      stub(prisma, '$transaction', async (fn: any) => fn(mockTx));

      const result = await RoomManagementRepository.transitionToMaintenanceTransaction(mockRoomId);

      assert.equal(updateWhere.id, mockRoomId);
      assert.equal(updateWhere.occupancyStatus, 'VACANT');
      assert.equal(updateData.occupancyStatus, 'MAINTENANCE');
      assert.equal(updateData.visibilityStatus, 'HIDDEN');
      assert.equal(result.occupancyStatus, 'MAINTENANCE');
      assert.equal(result.visibilityStatus, 'HIDDEN');
    });
  });

  describe('transitionToVacantTransaction', () => {
    test('ném 409 INVALID_STATUS_TRANSITION khi phòng không ở trạng thái MAINTENANCE (updateMany count = 0)', async () => {
      const mockTx: any = {
        room: {
          updateMany: async () => ({ count: 0 }),
        },
      };
      stub(prisma, '$transaction', async (fn: any) => fn(mockTx));

      await assert.rejects(
        () => RoomManagementRepository.transitionToVacantTransaction(mockRoomId),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, 'INVALID_STATUS_TRANSITION');
          return true;
        },
      );
    });

    test('thành công chuyển từ MAINTENANCE về VACANT', async () => {
      let updateWhere: any = null;
      let updateData: any = null;

      const mockTx: any = {
        room: {
          updateMany: async ({ where, data }: any) => {
            updateWhere = where;
            updateData = data;
            return { count: 1 };
          },
          findUniqueOrThrow: async () => ({
            id: mockRoomId,
            occupancyStatus: 'VACANT',
            visibilityStatus: 'HIDDEN',
          }),
        },
      };
      stub(prisma, '$transaction', async (fn: any) => fn(mockTx));

      const result = await RoomManagementRepository.transitionToVacantTransaction(mockRoomId);

      assert.equal(updateWhere.id, mockRoomId);
      assert.equal(updateWhere.occupancyStatus, 'MAINTENANCE');
      assert.equal(updateData.occupancyStatus, 'VACANT');
      assert.equal(result.occupancyStatus, 'VACANT');
    });
  });

  describe('updateOperationalStatus', () => {
    test('cập nhật occupancyStatus và tự động chuyển visibilityStatus về HIDDEN khi có newVisibility', async () => {
      let updatedData: any = null;

      stub(prisma.room, 'update', async ({ where, data }: any) => {
        assert.equal(where.id, mockRoomId);
        updatedData = data;
        return { id: mockRoomId, ...data };
      });

      await RoomManagementRepository.updateOperationalStatus(mockRoomId, 'MAINTENANCE', 'HIDDEN');

      assert.equal(updatedData.occupancyStatus, 'MAINTENANCE');
      assert.equal(updatedData.visibilityStatus, 'HIDDEN');
    });

    test('cập nhật occupancyStatus về VACANT mà không đổi visibilityStatus nếu không truyền newVisibility', async () => {
      let updatedData: any = null;

      stub(prisma.room, 'update', async ({ where, data }: any) => {
        updatedData = data;
        return { id: mockRoomId, ...data };
      });

      await RoomManagementRepository.updateOperationalStatus(mockRoomId, 'VACANT');

      assert.equal(updatedData.occupancyStatus, 'VACANT');
      assert.equal(updatedData.visibilityStatus, undefined);
    });
  });

  describe('updateVisibility', () => {
    test('cập nhật visibilityStatus thành công', async () => {
      let updatedData: any = null;

      stub(prisma.room, 'update', async ({ where, data }: any) => {
        assert.equal(where.id, mockRoomId);
        updatedData = data;
        return { id: mockRoomId, ...data };
      });

      await RoomManagementRepository.updateVisibility(mockRoomId, 'VISIBLE');

      assert.equal(updatedData.visibilityStatus, 'VISIBLE');
    });
  });
});
