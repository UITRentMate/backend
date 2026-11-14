import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ApiError } from '../../src/common/errors/api-error';
import { PropertyRepository } from '../../src/modules/properties/property.repository';
import { PropertyService } from '../../src/modules/properties/property.service';

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

const sampleProperty = {
  id: mockPropertyId,
  landlordId: mockLandlordId,
  name: 'Nhà trọ Hòa Bình',
  address: '123 Đỗ Xuân Hợp',
  houseRules: 'Nội quy',
  coverImageUrl: null,
  status: 'ACTIVE',
  createdAt: new Date(),
  updatedAt: new Date(),
  landlord: {
    id: mockLandlordId,
    fullName: 'Nguyễn Văn Chủ',
    accountStatus: 'ACTIVE',
  },
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
};

test('createProperty rejects when amenityIds validation fails', async () => {
  stub(PropertyRepository, 'validateAmenityIds', async () => false);

  await assert.rejects(
    () =>
      PropertyService.createProperty(mockLandlordId, {
        name: 'Trọ mới',
        address: 'Địa chỉ',
        houseRules: null,
        coverImageUrl: null,
        amenityIds: ['invalid-amenity'],
      }),
    (err: any) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, 'VALIDATION_ERROR');
      return true;
    },
  );
});

test('getLandlordPropertyDetail returns 404 when property belongs to another landlord (security against enumeration)', async () => {
  stub(PropertyRepository, 'findPropertyById', async () => sampleProperty);

  await assert.rejects(
    () => PropertyService.getLandlordPropertyDetail(otherLandlordId, mockPropertyId),
    (err: any) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, 'PROPERTY_NOT_FOUND');
      return true;
    },
  );
});

test('getPublicPropertyDetail returns 404 when property status is not ACTIVE', async () => {
  stub(PropertyRepository, 'findPropertyById', async () => ({
    ...sampleProperty,
    status: 'INACTIVE',
  }));

  await assert.rejects(
    () => PropertyService.getPublicPropertyDetail(mockPropertyId),
    (err: any) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, 'PROPERTY_NOT_FOUND');
      return true;
    },
  );
});

test('getPublicPropertyDetail returns 404 when landlord accountStatus is not ACTIVE', async () => {
  stub(PropertyRepository, 'findPropertyById', async () => ({
    ...sampleProperty,
    landlord: {
      ...sampleProperty.landlord,
      accountStatus: 'LOCKED',
    },
  }));

  await assert.rejects(
    () => PropertyService.getPublicPropertyDetail(mockPropertyId),
    (err: any) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, 'PROPERTY_NOT_FOUND');
      return true;
    },
  );
});

test('getPublicPropertyDetail returns 404 when property has 0 public rooms (all hidden or maintenance)', async () => {
  stub(PropertyRepository, 'findPropertyById', async () => ({
    ...sampleProperty,
    rooms: [
      {
        id: 'room-hidden',
        occupancyStatus: 'VACANT',
        visibilityStatus: 'HIDDEN',
        isArchived: false,
      },
      {
        id: 'room-maint',
        occupancyStatus: 'MAINTENANCE',
        visibilityStatus: 'VISIBLE',
        isArchived: false,
      },
    ],
  }));

  await assert.rejects(
    () => PropertyService.getPublicPropertyDetail(mockPropertyId),
    (err: any) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, 'PROPERTY_NOT_FOUND');
      return true;
    },
  );
});

test('getPublicPropertyDetail returns public property and filters out hidden rooms', async () => {
  stub(PropertyRepository, 'findPropertyById', async () => ({
    ...sampleProperty,
    rooms: [
      sampleProperty.rooms[0], // VACANT, VISIBLE, not archived
      {
        id: 'room-hidden',
        roomCode: 'P102',
        occupancyStatus: 'VACANT',
        visibilityStatus: 'HIDDEN',
        isArchived: false,
        areaM2: 20,
        maxOccupants: 1,
        monthlyRent: 2000000,
        depositRequired: 2000000,
        floor: 1,
        images: [],
      },
    ],
  }));

  const result = await PropertyService.getPublicPropertyDetail(mockPropertyId);
  assert.equal(result.id, mockPropertyId);
  assert.equal(result.rooms.length, 1);
  assert.equal(result.rooms[0].roomCode, 'P101');
  assert.equal(result.totalVacantRooms, 1);
});

test('archiveProperty rejects with 409 CONFLICT if property has RENTED or HELD rooms', async () => {
  stub(PropertyRepository, 'findPropertyById', async () => ({
    ...sampleProperty,
    rooms: [
      {
        id: 'room-rented',
        occupancyStatus: 'RENTED',
        isArchived: false,
      },
    ],
  }));

  await assert.rejects(
    () => PropertyService.archiveProperty(mockLandlordId, mockPropertyId),
    (err: any) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'CONFLICT');
      return true;
    },
  );
});
