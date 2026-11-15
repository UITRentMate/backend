import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { afterEach, describe, test } from 'node:test';
import { app } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { signAccessToken } from '../../src/modules/auth/auth.security';
import { RoomRepository } from '../../src/modules/rooms/room.repository';

process.env.JWT_SECRET = 'test-secret-must-have-at-least-thirty-two-bytes';

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

const mockLandlord = {
  id: '550e8400-e29b-41d4-a716-446655440001',
  role: 'LANDLORD',
  accountStatus: 'ACTIVE',
  fullName: 'Chủ Trọ A',
  email: 'chutro@example.com',
  phone: '0901234567',
};

const mockTenant = {
  id: '550e8400-e29b-41d4-a716-446655440002',
  role: 'TENANT',
  accountStatus: 'ACTIVE',
  fullName: 'Người Thuê B',
  email: 'tenant@example.com',
  phone: '0907654321',
};

const mockPropertyId = '550e8400-e29b-41d4-a716-446655440010';
const mockRoomId = '550e8400-e29b-41d4-a716-446655440020';
const mockAmenityId = '550e8400-e29b-41d4-a716-446655440030';

const sampleRoomData = {
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
        id: mockAmenityId,
        name: 'Máy lạnh',
        scope: 'ROOM',
      },
    },
  ],
  serviceFees: [
    {
      id: 'fee-1',
      feeName: 'Vệ sinh hành lang',
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
    landlordId: mockLandlord.id,
    name: 'Khu trọ Hưng Thịnh',
    address: '123 Đỗ Xuân Hợp',
    status: 'ACTIVE',
    landlord: {
      id: mockLandlord.id,
      accountStatus: 'ACTIVE',
    },
  },
};

async function request(path: string, init: RequestInit = {}) {
  const server = app.listen(0);
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const text = await response.text();
    let body: any = {};
    try {
      body = JSON.parse(text);
    } catch {}
    return { response, body };
  } finally {
    server.close();
  }
}

describe('Room Management API Integration Tests (BE-P2-02)', () => {
  describe('POST /api/v1/landlord/properties/:propertyId/rooms', () => {
    test('trả về 401 UNAUTHORIZED khi thiếu Bearer Token', async () => {
      const { response, body } = await request(
        `/api/v1/landlord/properties/${mockPropertyId}/rooms`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomCode: 'P.301', areaM2: 25 }),
        },
      );

      assert.equal(response.status, 401);
      assert.equal(body.code, 'UNAUTHORIZED');
    });

    test('trả về 403 FORBIDDEN khi tài khoản TENANT gọi vào', async () => {
      stub(prisma.user, 'findUnique', async () => mockTenant);

      const { response, body } = await request(
        `/api/v1/landlord/properties/${mockPropertyId}/rooms`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signAccessToken(mockTenant.id)}`,
          },
          body: JSON.stringify({
            roomCode: 'P.301',
            areaM2: 25,
            maxOccupants: 2,
            monthlyRent: 3500000,
            depositRequired: 3500000,
            electricityRate: 3800,
            waterRate: 25000,
          }),
        },
      );

      assert.equal(response.status, 403);
      assert.equal(body.code, 'FORBIDDEN');
    });

    test('trả về 404 PROPERTY_NOT_FOUND khi khu trọ không thuộc sở hữu của chủ trọ', async () => {
      stub(prisma.user, 'findUnique', async () => mockLandlord);
      stub(prisma.property, 'count', async () => 0); // Property not found for this landlord

      const { response, body } = await request(
        `/api/v1/landlord/properties/${mockPropertyId}/rooms`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
          },
          body: JSON.stringify({
            roomCode: 'P.301',
            areaM2: 25,
            maxOccupants: 2,
            monthlyRent: 3500000,
            depositRequired: 3500000,
            electricityRate: 3800,
            waterRate: 25000,
          }),
        },
      );

      assert.equal(response.status, 404);
      assert.equal(body.code, 'PROPERTY_NOT_FOUND');
    });

    test('trả về 409 ROOM_CODE_ALREADY_EXISTS khi mã phòng đã tồn tại trong khu trọ', async () => {
      stub(prisma.user, 'findUnique', async () => mockLandlord);
      stub(prisma.property, 'count', async () => 1);
      stub(prisma.room, 'count', async () => 1); // duplicate roomCode

      const { response, body } = await request(
        `/api/v1/landlord/properties/${mockPropertyId}/rooms`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
          },
          body: JSON.stringify({
            roomCode: 'P.301',
            areaM2: 25,
            maxOccupants: 2,
            monthlyRent: 3500000,
            depositRequired: 3500000,
            electricityRate: 3800,
            waterRate: 25000,
          }),
        },
      );

      assert.equal(response.status, 409);
      assert.equal(body.code, 'ROOM_CODE_ALREADY_EXISTS');
    });

    test('trả về 201 Created khi landlord hợp lệ và dữ liệu hợp lệ', async () => {
      stub(prisma.user, 'findUnique', async () => mockLandlord);
      stub(prisma.property, 'count', async () => 1);
      stub(prisma.room, 'count', async () => 0);
      stub(prisma.amenity, 'count', async () => 1);

      stub(prisma, '$transaction', async (cb: any) => {
        return cb({
          room: {
            count: async () => 0,
            create: async () => ({ id: mockRoomId }),
            findUniqueOrThrow: async () => sampleRoomData,
          },
          roomAmenity: {
            createMany: async () => ({ count: 1 }),
          },
          roomServiceFee: {
            createMany: async () => ({ count: 1 }),
          },
        });
      });

      const { response, body } = await request(
        `/api/v1/landlord/properties/${mockPropertyId}/rooms`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
          },
          body: JSON.stringify({
            roomCode: 'P.301',
            floor: 3,
            areaM2: 28.5,
            maxOccupants: 2,
            monthlyRent: 4500000,
            depositRequired: 4500000,
            electricityRate: 3800,
            waterRate: 25000,
            amenityIds: [mockAmenityId],
            serviceFees: [
              { feeName: 'Vệ sinh hành lang', monthlyAmount: 50000, isRequired: true },
            ],
          }),
        },
      );

      assert.equal(response.status, 201);
      assert.equal(body.id, mockRoomId);
      assert.equal(body.roomCode, 'P.301');
      assert.equal(body.occupancyStatus, 'VACANT');
      assert.equal(body.visibilityStatus, 'HIDDEN');
      assert.equal(body.isArchived, false);
      assert.equal(body.amenities.length, 1);
      assert.equal(body.serviceFees.length, 1);
    });
  });

  describe('GET /api/v1/landlord/properties/:propertyId/rooms', () => {
    test('trả về 200 OK với danh sách phòng phân trang và khối summary counters', async () => {
      stub(prisma.user, 'findUnique', async () => mockLandlord);
      stub(prisma.property, 'count', async () => 1);
      stub(prisma.room, 'findMany', async (args: any) => {
        if (args.select) {
          return [
            { occupancyStatus: 'VACANT', visibilityStatus: 'VISIBLE' },
            { occupancyStatus: 'VACANT', visibilityStatus: 'HIDDEN' },
            { occupancyStatus: 'MAINTENANCE', visibilityStatus: 'HIDDEN' },
            { occupancyStatus: 'RENTED', visibilityStatus: 'HIDDEN' },
            { occupancyStatus: 'HELD', visibilityStatus: 'HIDDEN' },
          ];
        }
        return [sampleRoomData];
      });
      stub(prisma.room, 'count', async () => 1);

      const { response, body } = await request(
        `/api/v1/landlord/properties/${mockPropertyId}/rooms?page=1&pageSize=10`,
        {
          headers: {
            Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
          },
        },
      );

      assert.equal(response.status, 200);
      assert.equal(body.totalItems, 1);
      assert.equal(body.totalPages, 1);
      assert.equal(body.items.length, 1);
      assert.equal(body.items[0].roomCode, 'P.301');
      assert.equal(body.summary.total, 5);
      assert.equal(body.summary.vacant, 2);
      assert.equal(body.summary.maintenance, 1);
      assert.equal(body.summary.rented, 1);
      assert.equal(body.summary.held, 1);
      assert.equal(body.summary.visible, 1);
      assert.equal(body.summary.hidden, 4);
    });
  });

  describe('GET /api/v1/landlord/rooms/:roomId', () => {
    test('trả về 200 OK với chi tiết phòng đầy đủ khi chủ trọ sở hữu', async () => {
      stub(prisma.user, 'findUnique', async () => mockLandlord);
      stub(prisma.room, 'findUnique', async () => sampleRoomData);

      const { response, body } = await request(`/api/v1/landlord/rooms/${mockRoomId}`, {
        headers: {
          Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
        },
      });

      assert.equal(response.status, 200);
      assert.equal(body.id, mockRoomId);
      assert.equal(body.roomCode, 'P.301');
      assert.equal(body.areaM2, 28.5);
      assert.equal(body.amenities.length, 1);
      assert.equal(body.serviceFees.length, 1);
    });

    test('trả về 404 ROOM_NOT_FOUND khi phòng thuộc chủ trọ khác', async () => {
      stub(prisma.user, 'findUnique', async () => mockLandlord);
      stub(prisma.room, 'findUnique', async () => ({
        ...sampleRoomData,
        property: {
          ...sampleRoomData.property,
          landlordId: 'different-landlord-uuid',
        },
      }));

      const { response, body } = await request(`/api/v1/landlord/rooms/${mockRoomId}`, {
        headers: {
          Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
        },
      });

      assert.equal(response.status, 404);
      assert.equal(body.code, 'ROOM_NOT_FOUND');
    });
  });

  describe('PUT /api/v1/landlord/rooms/:roomId', () => {
    test('trả về 200 OK khi Full Replace cập nhật thông tin phòng, tiện ích, phí dịch vụ', async () => {
      stub(prisma.user, 'findUnique', async () => mockLandlord);
      stub(prisma.room, 'findUnique', async () => sampleRoomData);
      stub(prisma.room, 'count', async () => 0); // no duplicate
      stub(prisma.amenity, 'count', async () => 1);

      stub(prisma, '$transaction', async (cb: any) => {
        return cb({
          roomAmenity: {
            deleteMany: async () => ({ count: 1 }),
            createMany: async () => ({ count: 1 }),
          },
          roomServiceFee: {
            deleteMany: async () => ({ count: 1 }),
            createMany: async () => ({ count: 1 }),
          },
          room: {
            findUnique: async () => ({ propertyId: mockPropertyId }),
            count: async () => 0,
            update: async () => ({ id: mockRoomId }),
            findUniqueOrThrow: async () => ({
              ...sampleRoomData,
              roomCode: 'P.301-VIP',
              areaM2: 32,
            }),
          },
        });
      });

      const { response, body } = await request(`/api/v1/landlord/rooms/${mockRoomId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
        },
        body: JSON.stringify({
          roomCode: 'P.301-VIP',
          floor: 3,
          areaM2: 32,
          maxOccupants: 3,
          monthlyRent: 5000000,
          depositRequired: 5000000,
          electricityRate: 3800,
          waterRate: 25000,
          amenityIds: [mockAmenityId],
          serviceFees: [
            { feeName: 'Vệ sinh cao cấp', monthlyAmount: 70000, isRequired: true },
          ],
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(body.roomCode, 'P.301-VIP');
      assert.equal(body.areaM2, 32);
    });
  });

  describe('PATCH /api/v1/landlord/rooms/:roomId/operational-status', () => {
    test('trả về 409 Conflict khi cố tình chuyển sang HELD hoặc RENTED', async () => {
      stub(prisma.user, 'findUnique', async () => mockLandlord);

      const { response, body } = await request(
        `/api/v1/landlord/rooms/${mockRoomId}/operational-status`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
          },
          body: JSON.stringify({ occupancyStatus: 'HELD' }),
        },
      );

      assert.equal(response.status, 409);
      assert.equal(body.code, 'INVALID_STATUS_TRANSITION');
    });

    test('trả về 409 Conflict khi phòng hiện tại là RENTED cố tình chuyển sang VACANT', async () => {
      stub(prisma.user, 'findUnique', async () => mockLandlord);
      stub(prisma.room, 'findUnique', async () => ({
        ...sampleRoomData,
        occupancyStatus: 'RENTED',
      }));

      const { response, body } = await request(
        `/api/v1/landlord/rooms/${mockRoomId}/operational-status`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
          },
          body: JSON.stringify({ occupancyStatus: 'VACANT' }),
        },
      );

      assert.equal(response.status, 409);
      assert.equal(body.code, 'INVALID_STATUS_TRANSITION');
    });

    test('trả về 409 Conflict khi phòng hiện tại là HELD cố tình chuyển sang MAINTENANCE', async () => {
      stub(prisma.user, 'findUnique', async () => mockLandlord);
      stub(prisma.room, 'findUnique', async () => ({
        ...sampleRoomData,
        occupancyStatus: 'HELD',
      }));

      const { response, body } = await request(
        `/api/v1/landlord/rooms/${mockRoomId}/operational-status`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
          },
          body: JSON.stringify({ occupancyStatus: 'MAINTENANCE' }),
        },
      );

      assert.equal(response.status, 409);
      assert.equal(body.code, 'INVALID_STATUS_TRANSITION');
    });

    test('trả về 409 Conflict khi chuyển MAINTENANCE nhưng phòng có hợp đồng hiệu lực trong transaction', async () => {
      stub(prisma.user, 'findUnique', async () => mockLandlord);
      stub(prisma.room, 'findUnique', async () => ({
        ...sampleRoomData,
        occupancyStatus: 'VACANT',
      }));
      stub(prisma, '$transaction', async (cb: any) => {
        return cb({
          contract: { count: async () => 1 },
          rentalRequest: { count: async () => 0 },
        });
      });

      const { response, body } = await request(
        `/api/v1/landlord/rooms/${mockRoomId}/operational-status`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
          },
          body: JSON.stringify({ occupancyStatus: 'MAINTENANCE' }),
        },
      );

      assert.equal(response.status, 409);
      assert.equal(body.code, 'CANNOT_MAINTAIN_ACTIVE_ROOM');
    });

    test('trả về 200 OK khi chuyển sang MAINTENANCE (tự động hạ visibilityStatus về HIDDEN trong transaction)', async () => {
      stub(prisma.user, 'findUnique', async () => mockLandlord);
      stub(prisma.room, 'findUnique', async () => ({
        ...sampleRoomData,
        occupancyStatus: 'VACANT',
        visibilityStatus: 'VISIBLE',
      }));
      stub(prisma, '$transaction', async (cb: any) => {
        return cb({
          contract: { count: async () => 0 },
          rentalRequest: { count: async () => 0 },
          room: {
            updateMany: async () => ({ count: 1 }),
            findUniqueOrThrow: async () => ({
              ...sampleRoomData,
              occupancyStatus: 'MAINTENANCE',
              visibilityStatus: 'HIDDEN',
            }),
          },
        });
      });

      const { response, body } = await request(
        `/api/v1/landlord/rooms/${mockRoomId}/operational-status`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
          },
          body: JSON.stringify({ occupancyStatus: 'MAINTENANCE' }),
        },
      );

      assert.equal(response.status, 200);
      assert.equal(body.occupancyStatus, 'MAINTENANCE');
      assert.equal(body.visibilityStatus, 'HIDDEN');
    });

    test('trả về 200 OK khi chuyển từ MAINTENANCE về VACANT trong transaction', async () => {
      stub(prisma.user, 'findUnique', async () => mockLandlord);
      stub(prisma.room, 'findUnique', async () => ({
        ...sampleRoomData,
        occupancyStatus: 'MAINTENANCE',
        visibilityStatus: 'HIDDEN',
      }));
      stub(prisma, '$transaction', async (cb: any) => {
        return cb({
          room: {
            updateMany: async () => ({ count: 1 }),
            findUniqueOrThrow: async () => ({
              ...sampleRoomData,
              occupancyStatus: 'VACANT',
              visibilityStatus: 'HIDDEN',
            }),
          },
        });
      });

      const { response, body } = await request(
        `/api/v1/landlord/rooms/${mockRoomId}/operational-status`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
          },
          body: JSON.stringify({ occupancyStatus: 'VACANT' }),
        },
      );

      assert.equal(response.status, 200);
      assert.equal(body.occupancyStatus, 'VACANT');
      assert.equal(body.visibilityStatus, 'HIDDEN');
    });
  });

  describe('PATCH /api/v1/landlord/rooms/:roomId/visibility', () => {
    test('trả về 200 OK khi chuyển sang HIDDEN', async () => {
      stub(prisma.user, 'findUnique', async () => mockLandlord);
      stub(prisma.room, 'findUnique', async () => ({
        ...sampleRoomData,
        visibilityStatus: 'VISIBLE',
      }));
      stub(prisma.room, 'update', async () => ({
        ...sampleRoomData,
        visibilityStatus: 'HIDDEN',
      }));

      const { response, body } = await request(
        `/api/v1/landlord/rooms/${mockRoomId}/visibility`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
          },
          body: JSON.stringify({ visibilityStatus: 'HIDDEN' }),
        },
      );

      assert.equal(response.status, 200);
      assert.equal(body.visibilityStatus, 'HIDDEN');
    });

    test('trả về 409 Conflict khi bật VISIBLE cho phòng đang MAINTENANCE', async () => {
      stub(prisma.user, 'findUnique', async () => mockLandlord);
      stub(prisma.room, 'findUnique', async () => ({
        ...sampleRoomData,
        occupancyStatus: 'MAINTENANCE',
      }));

      const { response, body } = await request(
        `/api/v1/landlord/rooms/${mockRoomId}/visibility`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
          },
          body: JSON.stringify({ visibilityStatus: 'VISIBLE' }),
        },
      );

      assert.equal(response.status, 409);
      assert.equal(body.code, 'CANNOT_PUBLISH_ROOM');
    });

    test('trả về 200 OK khi bật VISIBLE thỏa mãn toàn bộ 5 điều kiện Phase 1', async () => {
      stub(prisma.user, 'findUnique', async () => mockLandlord);
      stub(prisma.room, 'findUnique', async () => sampleRoomData);
      stub(prisma.room, 'update', async () => ({
        ...sampleRoomData,
        visibilityStatus: 'VISIBLE',
      }));

      const { response, body } = await request(
        `/api/v1/landlord/rooms/${mockRoomId}/visibility`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
          },
          body: JSON.stringify({ visibilityStatus: 'VISIBLE' }),
        },
      );

      assert.equal(response.status, 200);
      assert.equal(body.visibilityStatus, 'VISIBLE');
    });
  });

  describe('Public Endpoints & Route Order Normalization', () => {
    const samplePublicRoomData = {
      ...sampleRoomData,
      property: {
        ...sampleRoomData.property,
        propertyAmenities: [],
        landlord: {
          ...sampleRoomData.property.landlord,
          landlordApplicationsAsApplicant: [{ id: 'app-1', status: 'APPROVED' }],
        },
      },
    };

    test('GET /api/v1/rooms/:roomId trả về 200 OK (URL Canonical)', async () => {
      stub(RoomRepository, 'findPublicRoomById', async () => samplePublicRoomData as any);
      stub(RoomRepository, 'countPropertyRooms', async () => 10);
      stub(RoomRepository, 'countPropertyVacantRooms', async () => 3);

      const { response, body } = await request(`/api/v1/rooms/${mockRoomId}`);

      assert.equal(response.status, 200);
      assert.equal(body.roomId, mockRoomId);
      assert.equal(body.roomCode, 'P.301');
      assert.equal(response.headers.get('Deprecation'), null);
    });

    test('GET /api/v1/public/rooms/:roomId trả về 200 OK và chứa header Deprecation: true (Deprecated Alias)', async () => {
      stub(RoomRepository, 'findPublicRoomById', async () => samplePublicRoomData as any);
      stub(RoomRepository, 'countPropertyRooms', async () => 10);
      stub(RoomRepository, 'countPropertyVacantRooms', async () => 3);

      const { response, body } = await request(`/api/v1/public/rooms/${mockRoomId}`);

      assert.equal(response.status, 200);
      assert.equal(body.roomId, mockRoomId);
      assert.equal(body.roomCode, 'P.301');
      assert.equal(response.headers.get('Deprecation'), 'true');
    });

    test('GET /api/v1/rooms/search hoạt động bình thường, không bị route /:roomId nuốt nhầm', async () => {
      stub(RoomRepository, 'countPublicRooms', async () => 0);
      stub(RoomRepository, 'findPublicRooms', async () => []);

      const { response, body } = await request('/api/v1/rooms/search');

      assert.equal(response.status, 200);
      assert.equal(body.totalItems, 0);
      assert.equal(body.page, 1);
      assert.equal(body.pageSize, 12);
      assert.deepEqual(body.items, []);
    });
  });
});
