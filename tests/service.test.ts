import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { RoomService } from '../src/modules/rooms/room.service';
import { RoomRepository } from '../src/modules/rooms/room.repository';
import { ApiError } from '../src/common/errors/api-error';
import { type SearchRoomsQuery } from '../src/modules/rooms/room.types';

describe('RoomService Orchestration & Business Policy Unit Tests', () => {
  test('Service không import Prisma Client singleton hoặc chứa truy vấn Prisma trực tiếp', () => {
    const serviceFilePath = path.join(__dirname, '../src/modules/rooms/room.service.ts');
    const content = fs.readFileSync(serviceFilePath, 'utf8');

    // Không import prisma client singleton
    assert(!content.includes("from '../../infrastructure/database/prisma'"));
    assert(!content.includes("from '../infrastructure/database/prisma'"));

    // Không chứa câu lệnh truy vấn prisma.*
    assert(!content.includes('prisma.room.findMany'));
    assert(!content.includes('prisma.room.findFirst'));
    assert(!content.includes('prisma.room.count'));
  });

  test('searchRooms: Điều phối gọi Repository song song, tính pagination metadata và map DTO', async () => {
    const originalFind = RoomRepository.findPublicRooms;
    const originalCount = RoomRepository.countPublicRooms;

    let findCalled = false;
    let countCalled = false;

    const mockQuery: SearchRoomsQuery = {
      page: 2,
      pageSize: 10,
      sortBy: 'newest',
    };

    RoomRepository.findPublicRooms = async (q) => {
      findCalled = true;
      assert.deepEqual(q, mockQuery);
      return [
        {
          id: 'room-uuid-1',
          roomCode: 'P-201',
          monthlyRent: new Prisma.Decimal('3500000'),
          areaM2: new Prisma.Decimal('22.0'),
          maxOccupants: 2,
          occupancyStatus: 'VACANT',
          property: {
            id: 'prop-uuid-1',
            name: 'Nhà trọ Hoa Mai',
            address: '123 Đường Số 1, TP.HCM',
            propertyAmenities: [],
          },
          images: [{ imageUrl: 'https://img.rentmate.vn/p201.jpg' }],
          roomAmenities: [],
        },
      ];
    };

    RoomRepository.countPublicRooms = async (q) => {
      countCalled = true;
      assert.deepEqual(q, mockQuery);
      return 25; // 25 items với pageSize=10 -> totalPages=3
    };

    try {
      const result = await RoomService.searchRooms(mockQuery);

      assert.equal(findCalled, true);
      assert.equal(countCalled, true);
      assert.equal(result.page, 2);
      assert.equal(result.pageSize, 10);
      assert.equal(result.totalItems, 25);
      assert.equal(result.totalPages, 3);
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].roomId, 'room-uuid-1');
      assert.equal(result.items[0].title, 'Nhà trọ Hoa Mai - Phòng P-201');
    } finally {
      RoomRepository.findPublicRooms = originalFind;
      RoomRepository.countPublicRooms = originalCount;
    }
  });

  test('searchRooms: Khi totalItems = 0 thì totalPages = 0', async () => {
    const originalFind = RoomRepository.findPublicRooms;
    const originalCount = RoomRepository.countPublicRooms;

    RoomRepository.findPublicRooms = async () => [];
    RoomRepository.countPublicRooms = async () => 0;

    try {
      const result = await RoomService.searchRooms({
        page: 1,
        pageSize: 12,
        sortBy: 'newest',
      });

      assert.equal(result.totalItems, 0);
      assert.equal(result.totalPages, 0);
      assert.deepEqual(result.items, []);
    } finally {
      RoomRepository.findPublicRooms = originalFind;
      RoomRepository.countPublicRooms = originalCount;
    }
  });

  test('getPublicRoomDetail: Ném lỗi ApiError 404 ROOM_NOT_FOUND khi Repository trả về null', async () => {
    const originalFindById = RoomRepository.findPublicRoomById;
    RoomRepository.findPublicRoomById = async () => null;

    try {
      await assert.rejects(
        async () => {
          await RoomService.getPublicRoomDetail('7b8f9e61-3d2a-4a5b-b1c2-d3e4f5a6b7c8');
        },
        (err: unknown) => {
          assert(err instanceof ApiError);
          assert.equal(err.statusCode, 404);
          assert.equal(err.code, 'ROOM_NOT_FOUND');
          return true;
        }
      );
    } finally {
      RoomRepository.findPublicRoomById = originalFindById;
    }
  });

  test('getPublicRoomDetail: Điều phối đếm phòng tòa nhà và map chi tiết phòng đầy đủ', async () => {
    const originalFindById = RoomRepository.findPublicRoomById;
    const originalCountTotal = RoomRepository.countPropertyRooms;
    const originalCountVacant = RoomRepository.countPropertyVacantRooms;

    const mockRoomId = '7b8f9e61-3d2a-4a5b-b1c2-d3e4f5a6b7c8';
    const mockPropId = 'prop-uuid-123';

    RoomRepository.findPublicRoomById = async (id) => {
      assert.equal(id, mockRoomId);
      return {
        id: mockRoomId,
        propertyId: mockPropId,
        roomCode: 'AG-302',
        areaM2: new Prisma.Decimal('28.00'),
        maxOccupants: 2,
        floor: 3,
        monthlyRent: new Prisma.Decimal('4500000.00'),
        depositRequired: new Prisma.Decimal('4500000.00'),
        electricityRate: new Prisma.Decimal('3800.00'),
        waterRate: new Prisma.Decimal('25000.00'),
        occupancyStatus: 'VACANT',
        createdAt: new Date('2026-10-30T10:15:30.000Z'),
        images: [{ id: 'img-1', imageUrl: 'https://img.rentmate.vn/1.jpg', sortOrder: 0 }],
        roomAmenities: [],
        serviceFees: [],
        property: {
          id: mockPropId,
          name: 'Khu trọ An Gia Building',
          address: '285/12 CMT8, Phường 12, Quận 10, TP.HCM',
          houseRules: 'Giờ giấc tự do',
          coverImageUrl: 'https://img.rentmate.vn/prop.jpg',
          propertyAmenities: [],
          landlord: {
            id: 'user-landlord-uuid',
            fullName: 'Nguyễn Văn An',
            landlordApplicationsAsApplicant: [{ id: 'app-approved-uuid' }],
          },
        },
      };
    };

    RoomRepository.countPropertyRooms = async (propId) => {
      assert.equal(propId, mockPropId);
      return 20;
    };

    RoomRepository.countPropertyVacantRooms = async (propId) => {
      assert.equal(propId, mockPropId);
      return 5;
    };

    try {
      const detail = await RoomService.getPublicRoomDetail(mockRoomId);
      assert.equal(detail.roomId, mockRoomId);
      assert.equal(detail.title, 'Khu trọ An Gia Building - Phòng AG-302');
      assert.equal(detail.property.summary.totalRooms, 20);
      assert.equal(detail.property.summary.vacantRooms, 5);
      assert.equal(detail.landlord.isVerified, true);
    } finally {
      RoomRepository.findPublicRoomById = originalFindById;
      RoomRepository.countPropertyRooms = originalCountTotal;
      RoomRepository.countPropertyVacantRooms = originalCountVacant;
    }
  });
});
