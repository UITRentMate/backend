import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { afterEach, test } from 'node:test';
import { app } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { signAccessToken } from '../../src/modules/auth/auth.security';

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

const samplePropertyData = {
  id: mockPropertyId,
  landlordId: mockLandlord.id,
  name: 'Nhà trọ Hưng Thịnh',
  address: '123 Đỗ Xuân Hợp',
  houseRules: 'Nội quy',
  coverImageUrl: null,
  status: 'ACTIVE',
  createdAt: new Date(),
  updatedAt: new Date(),
  propertyAmenities: [],
  rooms: [
    {
      id: 'room-1',
      roomCode: 'P101',
      occupancyStatus: 'VACANT',
      visibilityStatus: 'VISIBLE',
      isArchived: false,
      areaM2: 25,
      maxOccupants: 2,
      monthlyRent: 3000000,
      depositRequired: 3000000,
      floor: 1,
      images: [],
    },
  ],
  landlord: {
    id: mockLandlord.id,
    fullName: mockLandlord.fullName,
    accountStatus: 'ACTIVE',
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

test('POST /api/v1/landlord/properties requires auth token', async () => {
  const { response, body } = await request('/api/v1/landlord/properties', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Trọ mới', address: 'Địa chỉ' }),
  });

  assert.equal(response.status, 401);
  assert.equal(body.code, 'UNAUTHORIZED');
});

test('POST /api/v1/landlord/properties rejects TENANT role with 403', async () => {
  stub(prisma.user, 'findUnique', async () => mockTenant);

  const { response, body } = await request('/api/v1/landlord/properties', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signAccessToken(mockTenant.id)}`,
    },
    body: JSON.stringify({ name: 'Trọ mới', address: 'Địa chỉ' }),
  });

  assert.equal(response.status, 403);
  assert.equal(body.code, 'FORBIDDEN');
});

test('POST /api/v1/landlord/properties allows LANDLORD to create property', async () => {
  stub(prisma.user, 'findUnique', async () => mockLandlord);
  stub(prisma.amenity, 'count', async () => 0);
  stub(prisma, '$transaction', async (cb: any) => {
    return cb({
      property: {
        create: async () => ({ id: mockPropertyId }),
        findUniqueOrThrow: async () => samplePropertyData,
      },
      propertyAmenity: {
        createMany: async () => ({ count: 0 }),
      },
    });
  });

  const { response, body } = await request('/api/v1/landlord/properties', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
    },
    body: JSON.stringify({
      name: 'Nhà trọ Hưng Thịnh',
      address: '123 Đỗ Xuân Hợp',
      houseRules: 'Nội quy',
    }),
  });

  assert.equal(response.status, 201);
  assert.equal(body.id, mockPropertyId);
  assert.equal(body.name, 'Nhà trọ Hưng Thịnh');
  assert.equal(body.status, 'ACTIVE');
});

test('GET /api/v1/landlord/properties lists landlord properties with stats', async () => {
  stub(prisma.user, 'findUnique', async () => mockLandlord);
  stub(prisma.property, 'count', async () => 1);
  stub(prisma.property, 'findMany', async () => [samplePropertyData]);

  const { response, body } = await request('/api/v1/landlord/properties?page=1&pageSize=10', {
    headers: {
      Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(body.items.length, 1);
  assert.equal(body.totalItems, 1);
  assert.equal(body.items[0].name, 'Nhà trọ Hưng Thịnh');
  assert.equal(body.items[0].stats.vacantRooms, 1);
});

test('GET /api/v1/properties/:id returns 200 for public property with active room', async () => {
  stub(prisma.property, 'findUnique', async () => samplePropertyData);

  const { response, body } = await request(`/api/v1/properties/${mockPropertyId}`);

  assert.equal(response.status, 200);
  assert.equal(body.id, mockPropertyId);
  assert.equal(body.name, 'Nhà trọ Hưng Thịnh');
  assert.equal(body.rooms.length, 1);
  assert.equal(body.rooms[0].roomCode, 'P101');
});

test('GET /api/v1/properties/:id returns 404 when property has only hidden rooms', async () => {
  stub(prisma.property, 'findUnique', async () => ({
    ...samplePropertyData,
    rooms: [
      {
        ...samplePropertyData.rooms[0],
        visibilityStatus: 'HIDDEN',
      },
    ],
  }));

  const { response, body } = await request(`/api/v1/properties/${mockPropertyId}`);

  assert.equal(response.status, 404);
  assert.equal(body.code, 'PROPERTY_NOT_FOUND');
});

test('PATCH /api/v1/landlord/properties/:id/archive archives property when no active contracts', async () => {
  stub(prisma.user, 'findUnique', async () => mockLandlord);
  stub(prisma.property, 'findUnique', async () => samplePropertyData);
  stub(prisma.property, 'update', async () => ({ ...samplePropertyData, status: 'ARCHIVED' }));

  const { response, body } = await request(`/api/v1/landlord/properties/${mockPropertyId}/archive`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
});

test('GET /api/v1/landlord/properties/:propertyId returns 200 with landlord property detail', async () => {
  stub(prisma.user, 'findUnique', async () => mockLandlord);
  stub(prisma.property, 'findUnique', async () => samplePropertyData);

  const { response, body } = await request(`/api/v1/landlord/properties/${mockPropertyId}`, {
    headers: {
      Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(body.id, mockPropertyId);
  assert.equal(body.name, 'Nhà trọ Hưng Thịnh');
  assert.equal(body.rooms.length, 1);
  assert.equal(body.stats.vacantRooms, 1);
});

test('PUT /api/v1/landlord/properties/:propertyId updates property details and amenities', async () => {
  stub(prisma.user, 'findUnique', async () => mockLandlord);
  stub(prisma.property, 'findUnique', async () => samplePropertyData);
  stub(prisma.amenity, 'count', async () => 0);
  stub(prisma, '$transaction', async (cb: any) => {
    return cb({
      propertyAmenity: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async () => ({ count: 0 }),
      },
      property: {
        update: async () => ({ id: mockPropertyId }),
        findUniqueOrThrow: async () => ({
          ...samplePropertyData,
          name: 'Nhà trọ Hưng Thịnh Đã Cập Nhật',
        }),
      },
    });
  });

  const { response, body } = await request(`/api/v1/landlord/properties/${mockPropertyId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
    },
    body: JSON.stringify({
      name: 'Nhà trọ Hưng Thịnh Đã Cập Nhật',
      address: '123 Đỗ Xuân Hợp',
      houseRules: 'Giờ giấc tự do',
      coverImageUrl: '',
      amenityIds: [],
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(body.id, mockPropertyId);
  assert.equal(body.name, 'Nhà trọ Hưng Thịnh Đã Cập Nhật');
});

test('PUT /api/v1/landlord/properties/:propertyId returns 404 when property belongs to another landlord', async () => {
  stub(prisma.user, 'findUnique', async () => mockLandlord);
  stub(prisma.property, 'findUnique', async () => ({
    ...samplePropertyData,
    landlordId: 'different-landlord-uuid',
  }));

  const { response, body } = await request(`/api/v1/landlord/properties/${mockPropertyId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
    },
    body: JSON.stringify({
      name: 'Nhà trọ Hưng Thịnh',
      address: '123 Đỗ Xuân Hợp',
    }),
  });

  assert.equal(response.status, 404);
  assert.equal(body.code, 'PROPERTY_NOT_FOUND');
});
