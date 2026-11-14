import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mapToLandlordPropertyCard,
  mapToLandlordPropertyDetail,
  mapToPublicPropertyDetail,
} from '../../src/modules/properties/property.mapper';

const mockPrismaProperty = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  name: 'Nhà trọ Hưng Thịnh',
  address: '456 Võ Văn Ngân, Thủ Đức',
  houseRules: 'Khóa cổng 23h',
  coverImageUrl: 'https://images.unsplash.com/cover',
  status: 'ACTIVE',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  landlord: {
    id: 'landlord-uuid-1',
    fullName: 'Trần Văn Chủ',
    email: 'secret@example.com',
    phone: '0901234567',
  },
  propertyAmenities: [
    {
      amenity: {
        id: 'amenity-1',
        name: 'Nhà xe an ninh',
        scope: 'PROPERTY',
      },
    },
  ],
  rooms: [
    {
      id: 'room-1',
      roomCode: 'P101',
      floor: 1,
      areaM2: 25.5,
      maxOccupants: 2,
      monthlyRent: 3500000,
      depositRequired: 3500000,
      occupancyStatus: 'VACANT',
      visibilityStatus: 'VISIBLE',
      isArchived: false,
      images: [{ imageUrl: 'https://images.unsplash.com/room1' }],
    },
    {
      id: 'room-2',
      roomCode: 'P102',
      floor: 1,
      areaM2: 20.0,
      maxOccupants: 1,
      monthlyRent: 2800000,
      depositRequired: 2800000,
      occupancyStatus: 'MAINTENANCE',
      visibilityStatus: 'HIDDEN',
      isArchived: false,
      images: [],
    },
  ],
};

const mockStats = {
  totalRooms: 2,
  vacantRooms: 1,
  occupiedRooms: 0,
  maintenanceRooms: 1,
};

test('mapToLandlordPropertyCard maps correctly', () => {
  const card = mapToLandlordPropertyCard(mockPrismaProperty, mockStats);
  assert.equal(card.id, mockPrismaProperty.id);
  assert.equal(card.name, mockPrismaProperty.name);
  assert.deepEqual(card.stats, mockStats);
  assert.equal(card.amenities.length, 1);
  assert.equal(card.amenities[0].name, 'Nhà xe an ninh');
  assert.equal('rooms' in card, false);
});

test('mapToLandlordPropertyDetail includes all rooms including maintenance/hidden', () => {
  const detail = mapToLandlordPropertyDetail(mockPrismaProperty, mockStats);
  assert.equal(detail.id, mockPrismaProperty.id);
  assert.equal(detail.rooms.length, 2);
  assert.equal(detail.rooms[0].roomCode, 'P101');
  assert.equal(detail.rooms[1].roomCode, 'P102');
  assert.equal(detail.rooms[1].occupancyStatus, 'MAINTENANCE');
  assert.equal('updatedAt' in detail, false);
});

test('mapToPublicPropertyDetail shields landlord private info and maps public rooms only', () => {
  const publicRooms = [mockPrismaProperty.rooms[0]]; // Only public rooms passed in
  const detail = mapToPublicPropertyDetail(mockPrismaProperty, publicRooms, 1);

  assert.equal(detail.id, mockPrismaProperty.id);
  assert.equal(detail.landlord.id, mockPrismaProperty.landlord.id);
  assert.equal(detail.landlord.fullName, mockPrismaProperty.landlord.fullName);
  // Ensure private fields are NOT present
  assert.equal('email' in detail.landlord, false);
  assert.equal('phone' in detail.landlord, false);
  // Public rooms
  assert.equal(detail.rooms.length, 1);
  assert.equal(detail.rooms[0].roomCode, 'P101');
  assert.equal(detail.rooms[0].coverImageUrl, 'https://images.unsplash.com/room1');
  assert.equal(detail.totalVacantRooms, 1);
});
