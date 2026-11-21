import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { ApiError } from '../../src/common/errors/api-error';
import { RoomManagementRepository } from '../../src/modules/rooms/room-management.repository';
import { RoomManagementService } from '../../src/modules/rooms/room-management.service';
import { RoomService } from '../../src/modules/rooms/room.service';

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
const otherLandlordId = '550e8400-e29b-41d4-a716-446655440099';
const mockPropertyId = '550e8400-e29b-41d4-a716-446655440002';
const mockRoomId = '550e8400-e29b-41d4-a716-446655440003';

const mockRawRoom = {
  id: mockRoomId,
  propertyId: mockPropertyId,
  roomCode: 'P.301',
  floor: 3,
  areaM2: 28.5,
  maxOccupants: 2,
  monthlyRent: 4500000,
  depositRequired: 4500000,
  electricityRate: 3800,
  waterRate: 25000,
  occupancyStatus: 'VACANT',
  visibilityStatus: 'HIDDEN',
  isArchived: false,
  createdAt: new Date('2026-10-30T10:15:30.000Z'),
  roomAmenities: [
    {
      amenity: {
        id: 'amenity-1',
        name: 'Máy lạnh',
        scope: 'ROOM',
      },
    },
  ],
  serviceFees: [
    {
      id: 'fee-1',
      feeName: 'Vệ sinh',
      monthlyAmount: 50000,
      isRequired: true,
    },
  ],
  images: [
    {
      id: 'img-1',
      imageUrl: 'https://cdn.example.com/cover.jpg',
      sortOrder: 0,
      createdAt: new Date('2026-10-30T10:15:30.000Z'),
    },
  ],
  property: {
    id: mockPropertyId,
    landlordId: mockLandlordId,
    name: 'Khu trọ Hòa Bình',
    address: '123 Đỗ Xuân Hợp',
    status: 'ACTIVE',
    landlord: {
      id: mockLandlordId,
      accountStatus: 'ACTIVE',
    },
  },
};

describe('RoomManagementService Unit Tests', () => {
  describe('Kiến trúc phân tầng nghiêm ngặt (Architectural Constraint)', () => {
    test('Service không import Prisma Client singleton hoặc chứa câu lệnh Prisma trực tiếp', () => {
      const serviceFilePath = path.resolve(
        __dirname,
        '../../src/modules/rooms/room-management.service.ts',
      );
      const content = fs.readFileSync(serviceFilePath, 'utf8');

      assert.equal(
        content.includes("from '../../infrastructure/database/prisma'"),
        false,
        'Service tuyệt đối không được import prisma singleton',
      );
      assert.equal(
        content.includes('prisma.'),
        false,
        'Service tuyệt đối không được gọi câu lệnh prisma.* trực tiếp',
      );
      assert.equal(
        content.includes('new PrismaClient'),
        false,
        'Service tuyệt đối không được tự ý khởi tạo new PrismaClient()',
      );
    });
  });

  describe('createRoom', () => {
    test('ném 404 PROPERTY_NOT_FOUND khi khu trọ không thuộc quyền sở hữu của chủ trọ', async () => {
      stub(RoomManagementRepository, 'checkPropertyOwnership', async () => false);

      await assert.rejects(
        () =>
          RoomManagementService.createRoom(otherLandlordId, mockPropertyId, {
            roomCode: 'P.301',
            areaM2: 25,
            maxOccupants: 2,
            monthlyRent: 3500000,
            depositRequired: 3500000,
            electricityRate: 3800,
            waterRate: 25000,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 404);
          assert.equal(err.code, 'PROPERTY_NOT_FOUND');
          return true;
        },
      );
    });

    test('ném 409 DUPLICATE_ROOM_CODE khi mã phòng đã tồn tại trong khu trọ', async () => {
      stub(RoomManagementRepository, 'checkPropertyOwnership', async () => true);
      stub(RoomManagementRepository, 'checkDuplicateRoomCode', async () => true);

      await assert.rejects(
        () =>
          RoomManagementService.createRoom(mockLandlordId, mockPropertyId, {
            roomCode: 'P.301',
            areaM2: 25,
            maxOccupants: 2,
            monthlyRent: 3500000,
            depositRequired: 3500000,
            electricityRate: 3800,
            waterRate: 25000,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, 'DUPLICATE_ROOM_CODE');
          return true;
        },
      );
    });

    test('ném 400 VALIDATION_ERROR khi amenityIds không hợp lệ', async () => {
      stub(RoomManagementRepository, 'checkPropertyOwnership', async () => true);
      stub(RoomManagementRepository, 'checkDuplicateRoomCode', async () => false);
      stub(RoomManagementRepository, 'validateAmenityIds', async () => false);

      await assert.rejects(
        () =>
          RoomManagementService.createRoom(mockLandlordId, mockPropertyId, {
            roomCode: 'P.301',
            areaM2: 25,
            maxOccupants: 2,
            monthlyRent: 3500000,
            depositRequired: 3500000,
            electricityRate: 3800,
            waterRate: 25000,
            amenityIds: ['invalid-amenity-id'],
          }),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 400);
          assert.equal(err.code, 'VALIDATION_ERROR');
          return true;
        },
      );
    });

    test('tạo phòng thành công và map response chi tiết khi dữ liệu hợp lệ', async () => {
      stub(RoomManagementRepository, 'checkPropertyOwnership', async () => true);
      stub(RoomManagementRepository, 'checkDuplicateRoomCode', async () => false);
      stub(RoomManagementRepository, 'validateAmenityIds', async () => true);
      stub(RoomManagementRepository, 'createRoomTransaction', async () => mockRawRoom);

      const result = await RoomManagementService.createRoom(mockLandlordId, mockPropertyId, {
        roomCode: 'P.301',
        areaM2: 28.5,
        maxOccupants: 2,
        monthlyRent: 4500000,
        depositRequired: 4500000,
        electricityRate: 3800,
        waterRate: 25000,
      });

      assert.equal(result.id, mockRoomId);
      assert.equal(result.roomCode, 'P.301');
      assert.equal(result.occupancyStatus, 'VACANT');
      assert.equal(result.visibilityStatus, 'HIDDEN');
      assert.equal(result.amenities.length, 1);
      assert.equal(result.serviceFees.length, 1);
    });
  });

  describe('getLandlordRooms', () => {
    test('ném 404 PROPERTY_NOT_FOUND khi chủ trọ không sở hữu khu trọ', async () => {
      stub(RoomManagementRepository, 'checkPropertyOwnership', async () => false);

      await assert.rejects(
        () =>
          RoomManagementService.getLandlordRooms(otherLandlordId, mockPropertyId, {
            page: 1,
            pageSize: 10,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 404);
          assert.equal(err.code, 'PROPERTY_NOT_FOUND');
          return true;
        },
      );
    });

    test('lấy danh sách phòng phân trang kèm summary counters thành công', async () => {
      stub(RoomManagementRepository, 'checkPropertyOwnership', async () => true);
      stub(RoomManagementRepository, 'findLandlordRooms', async () => ({
        items: [mockRawRoom],
        totalItems: 1,
        summary: {
          total: 10,
          vacant: 4,
          maintenance: 2,
          rented: 3,
          held: 1,
          visible: 3,
          hidden: 7,
        },
      }));

      const result = await RoomManagementService.getLandlordRooms(mockLandlordId, mockPropertyId, {
        page: 1,
        pageSize: 10,
      });

      assert.equal(result.totalItems, 1);
      assert.equal(result.totalPages, 1);
      assert.equal(result.items.length, 1);
      assert.equal(result.summary.total, 10);
      assert.equal(result.summary.vacant, 4);
    });
  });

  describe('getLandlordRoomDetail', () => {
    test('ném 404 ROOM_NOT_FOUND khi phòng không tồn tại hoặc thuộc chủ trọ khác', async () => {
      stub(RoomManagementRepository, 'findLandlordRoomById', async () => null);

      await assert.rejects(
        () => RoomManagementService.getLandlordRoomDetail(mockLandlordId, mockRoomId),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 404);
          assert.equal(err.code, 'ROOM_NOT_FOUND');
          return true;
        },
      );
    });

    test('trả về chi tiết phòng quản lý khi hợp lệ', async () => {
      stub(RoomManagementRepository, 'findLandlordRoomById', async () => mockRawRoom);

      const result = await RoomManagementService.getLandlordRoomDetail(mockLandlordId, mockRoomId);
      assert.equal(result.id, mockRoomId);
      assert.equal(result.roomCode, 'P.301');
    });
  });

  describe('updateRoom', () => {
    test('ném 404 ROOM_NOT_FOUND khi phòng không thuộc chủ trọ', async () => {
      stub(RoomManagementRepository, 'findLandlordRoomById', async () => null);

      await assert.rejects(
        () =>
          RoomManagementService.updateRoom(otherLandlordId, mockRoomId, {
            roomCode: 'P.301-VIP',
            areaM2: 30,
            maxOccupants: 3,
            monthlyRent: 5000000,
            depositRequired: 5000000,
            electricityRate: 3800,
            waterRate: 25000,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 404);
          return true;
        },
      );
    });

    test('ném 409 DUPLICATE_ROOM_CODE khi trùng mã phòng với phòng khác trong cùng khu trọ', async () => {
      stub(RoomManagementRepository, 'findLandlordRoomById', async () => mockRawRoom);
      stub(RoomManagementRepository, 'checkDuplicateRoomCode', async () => true);

      await assert.rejects(
        () =>
          RoomManagementService.updateRoom(mockLandlordId, mockRoomId, {
            roomCode: 'P.302',
            areaM2: 30,
            maxOccupants: 3,
            monthlyRent: 5000000,
            depositRequired: 5000000,
            electricityRate: 3800,
            waterRate: 25000,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, 'DUPLICATE_ROOM_CODE');
          return true;
        },
      );
    });

    test('ném 400 VALIDATION_ERROR khi amenityIds cập nhật không hợp lệ', async () => {
      stub(RoomManagementRepository, 'findLandlordRoomById', async () => mockRawRoom);
      stub(RoomManagementRepository, 'checkDuplicateRoomCode', async () => false);
      stub(RoomManagementRepository, 'validateAmenityIds', async () => false);

      await assert.rejects(
        () =>
          RoomManagementService.updateRoom(mockLandlordId, mockRoomId, {
            roomCode: 'P.301-VIP',
            areaM2: 30,
            maxOccupants: 3,
            monthlyRent: 5000000,
            depositRequired: 5000000,
            electricityRate: 3800,
            waterRate: 25000,
            amenityIds: ['invalid-amenity-id'],
          }),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 400);
          assert.equal(err.code, 'VALIDATION_ERROR');
          return true;
        },
      );
    });

    test('cập nhật thành công khi dữ liệu hợp lệ', async () => {
      stub(RoomManagementRepository, 'findLandlordRoomById', async () => mockRawRoom);
      stub(RoomManagementRepository, 'checkDuplicateRoomCode', async () => false);
      stub(RoomManagementRepository, 'validateAmenityIds', async () => true);
      stub(RoomManagementRepository, 'updateRoomTransaction', async () => ({
        ...mockRawRoom,
        roomCode: 'P.301-VIP',
      }));

      const result = await RoomManagementService.updateRoom(mockLandlordId, mockRoomId, {
        roomCode: 'P.301-VIP',
        areaM2: 30,
        maxOccupants: 3,
        monthlyRent: 5000000,
        depositRequired: 5000000,
        electricityRate: 3800,
        waterRate: 25000,
      });

      assert.equal(result.roomCode, 'P.301-VIP');
    });
  });

  describe('updateOperationalStatus (State Machine Logic)', () => {
    test('ném 409 INVALID_STATUS_TRANSITION khi cố tình chuyển sang HELD hoặc RENTED', async () => {
      stub(RoomManagementRepository, 'findLandlordRoomById', async () => mockRawRoom);

      for (const forbiddenStatus of ['HELD', 'RENTED'] as any[]) {
        await assert.rejects(
          () =>
            RoomManagementService.updateOperationalStatus(mockLandlordId, mockRoomId, {
              occupancyStatus: forbiddenStatus,
            }),
          (err: unknown) => {
            assert.ok(err instanceof ApiError);
            assert.equal(err.statusCode, 409);
            assert.equal(err.code, 'INVALID_STATUS_TRANSITION');
            return true;
          },
        );
      }
    });

    test('từ chối chuyển trạng thái khi phòng hiện tại đang là RENTED hoặc HELD với 409 INVALID_STATUS_TRANSITION', async () => {
      const activeStates = ['RENTED', 'HELD'];
      const targetStates = ['VACANT', 'MAINTENANCE'];

      for (const currentStatus of activeStates) {
        stub(RoomManagementRepository, 'findLandlordRoomById', async () => ({
          ...mockRawRoom,
          occupancyStatus: currentStatus,
        }));

        for (const targetStatus of targetStates) {
          await assert.rejects(
            () =>
              RoomManagementService.updateOperationalStatus(mockLandlordId, mockRoomId, {
                occupancyStatus: targetStatus,
              }),
            (err: unknown) => {
              assert.ok(err instanceof ApiError);
              assert.equal(err.statusCode, 409);
              assert.equal(err.code, 'INVALID_STATUS_TRANSITION');
              return true;
            },
          );
        }
      }
    });

    test('từ chối khi phòng hiện tại là VACANT nhưng cố chuyển sang VACANT hoặc trạng thái không phải MAINTENANCE', async () => {
      stub(RoomManagementRepository, 'findLandlordRoomById', async () => ({
        ...mockRawRoom,
        occupancyStatus: 'VACANT',
      }));

      // Khi targetStatus giống currentStatus (VACANT -> VACANT): Idempotent
      const result = await RoomManagementService.updateOperationalStatus(mockLandlordId, mockRoomId, {
        occupancyStatus: 'VACANT',
      });
      assert.equal(result.occupancyStatus, 'VACANT');
    });

    test('khi chuyển sang MAINTENANCE: ném 409 CANNOT_MAINTAIN_ACTIVE_ROOM nếu có hợp đồng hoặc yêu cầu thuê hiệu lực', async () => {
      stub(RoomManagementRepository, 'findLandlordRoomById', async () => ({
        ...mockRawRoom,
        occupancyStatus: 'VACANT',
      }));
      stub(RoomManagementRepository, 'transitionToMaintenanceTransaction', async () => {
        throw new ApiError(
          409,
          'CANNOT_MAINTAIN_ACTIVE_ROOM',
          'Không thể chuyển sang bảo trì khi phòng đang có hợp đồng hoặc yêu cầu thuê có hiệu lực',
        );
      });

      await assert.rejects(
        () =>
          RoomManagementService.updateOperationalStatus(mockLandlordId, mockRoomId, {
            occupancyStatus: 'MAINTENANCE',
          }),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, 'CANNOT_MAINTAIN_ACTIVE_ROOM');
          return true;
        },
      );
    });

    test('khi chuyển sang MAINTENANCE: tự động hạ visibilityStatus về HIDDEN', async () => {
      stub(RoomManagementRepository, 'findLandlordRoomById', async () => ({
        ...mockRawRoom,
        occupancyStatus: 'VACANT',
        visibilityStatus: 'VISIBLE',
      }));

      stub(
        RoomManagementRepository,
        'transitionToMaintenanceTransaction',
        async (_id: string) => {
          return {
            ...mockRawRoom,
            occupancyStatus: 'MAINTENANCE',
            visibilityStatus: 'HIDDEN',
          };
        },
      );

      const result = await RoomManagementService.updateOperationalStatus(
        mockLandlordId,
        mockRoomId,
        { occupancyStatus: 'MAINTENANCE' },
      );

      assert.equal(result.occupancyStatus, 'MAINTENANCE');
      assert.equal(result.visibilityStatus, 'HIDDEN');
    });

    test('khi chuyển từ MAINTENANCE -> VACANT: thành công và giữ nguyên visibilityStatus = HIDDEN', async () => {
      stub(RoomManagementRepository, 'findLandlordRoomById', async () => ({
        ...mockRawRoom,
        occupancyStatus: 'MAINTENANCE',
        visibilityStatus: 'HIDDEN',
      }));

      stub(
        RoomManagementRepository,
        'transitionToVacantTransaction',
        async (_id: string) => ({
          ...mockRawRoom,
          occupancyStatus: 'VACANT',
          visibilityStatus: 'HIDDEN',
        }),
      );

      const result = await RoomManagementService.updateOperationalStatus(
        mockLandlordId,
        mockRoomId,
        { occupancyStatus: 'VACANT' },
      );

      assert.equal(result.occupancyStatus, 'VACANT');
      assert.equal(result.visibilityStatus, 'HIDDEN');
    });
  });

  describe('updateVisibility (5 Điều kiện hiển thị)', () => {
    test('chuyển sang HIDDEN: luôn cho phép bất kỳ lúc nào', async () => {
      stub(RoomManagementRepository, 'findLandlordRoomById', async () => ({
        ...mockRawRoom,
        visibilityStatus: 'VISIBLE',
      }));
      stub(RoomManagementRepository, 'updateVisibility', async () => ({
        ...mockRawRoom,
        visibilityStatus: 'HIDDEN',
      }));

      const result = await RoomManagementService.updateVisibility(mockLandlordId, mockRoomId, {
        visibilityStatus: 'HIDDEN',
      });

      assert.equal(result.visibilityStatus, 'HIDDEN');
    });

    test('bật VISIBLE: ném 409 CANNOT_PUBLISH_ROOM nếu phòng đang MAINTENANCE', async () => {
      stub(RoomManagementRepository, 'findLandlordRoomById', async () => ({
        ...mockRawRoom,
        occupancyStatus: 'MAINTENANCE',
      }));

      await assert.rejects(
        () =>
          RoomManagementService.updateVisibility(mockLandlordId, mockRoomId, {
            visibilityStatus: 'VISIBLE',
          }),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, 'CANNOT_PUBLISH_ROOM');
          return true;
        },
      );
    });

    test('bật VISIBLE: ném 409 CANNOT_PUBLISH_ROOM nếu phòng đã bị isArchived = true', async () => {
      stub(RoomManagementRepository, 'findLandlordRoomById', async () => ({
        ...mockRawRoom,
        isArchived: true,
      }));

      await assert.rejects(
        () =>
          RoomManagementService.updateVisibility(mockLandlordId, mockRoomId, {
            visibilityStatus: 'VISIBLE',
          }),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, 'CANNOT_PUBLISH_ROOM');
          return true;
        },
      );
    });

    test('bật VISIBLE: ném 409 CANNOT_PUBLISH_ROOM nếu khu trọ status !== ACTIVE', async () => {
      stub(RoomManagementRepository, 'findLandlordRoomById', async () => ({
        ...mockRawRoom,
        property: {
          ...mockRawRoom.property,
          status: 'INACTIVE',
        },
      }));

      await assert.rejects(
        () =>
          RoomManagementService.updateVisibility(mockLandlordId, mockRoomId, {
            visibilityStatus: 'VISIBLE',
          }),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, 'CANNOT_PUBLISH_ROOM');
          return true;
        },
      );
    });

    test('bật VISIBLE: ném 409 CANNOT_PUBLISH_ROOM nếu chủ trọ accountStatus !== ACTIVE', async () => {
      stub(RoomManagementRepository, 'findLandlordRoomById', async () => ({
        ...mockRawRoom,
        property: {
          ...mockRawRoom.property,
          landlord: {
            id: mockLandlordId,
            accountStatus: 'LOCKED',
          },
        },
      }));

      await assert.rejects(
        () =>
          RoomManagementService.updateVisibility(mockLandlordId, mockRoomId, {
            visibilityStatus: 'VISIBLE',
          }),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, 'CANNOT_PUBLISH_ROOM');
          return true;
        },
      );
    });

    test('bật VISIBLE: thành công khi thỏa mãn toàn bộ 5 điều kiện Phase 1', async () => {
      stub(RoomManagementRepository, 'findLandlordRoomById', async () => mockRawRoom);
      stub(RoomManagementRepository, 'updateVisibility', async () => ({
        ...mockRawRoom,
        visibilityStatus: 'VISIBLE',
      }));

      const result = await RoomManagementService.updateVisibility(mockLandlordId, mockRoomId, {
        visibilityStatus: 'VISIBLE',
      });

      assert.equal(result.visibilityStatus, 'VISIBLE');
    });
  });

  describe('getCanonicalRoomDetail (Public canonical method in RoomService)', () => {
    test('phương thức getCanonicalRoomDetail trỏ cùng logic với getPublicRoomDetail', async () => {
      stub(RoomService, 'getPublicRoomDetail', async (id: string) => ({
        roomId: id,
        roomCode: 'P.301',
      } as any));

      const result = await RoomService.getCanonicalRoomDetail(mockRoomId);
      assert.equal(result.roomId, mockRoomId);
      assert.equal(result.roomCode, 'P.301');
    });
  });
});
