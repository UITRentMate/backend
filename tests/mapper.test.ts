import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import {
  mapToRoomCardDTO,
  mapToPublicRoomDetailDTO,
  type PrismaRoomCardRecord,
  type PrismaRoomDetailRecord,
} from '../src/modules/rooms/room.mapper';

describe('Room Discovery Mapper Tests', () => {
  test('mapToRoomCardDTO chuyển đổi chính xác bản ghi Prisma sang RoomCardDTO và chọn đúng ảnh đầu tiên', () => {
    const mockRecord: PrismaRoomCardRecord = {
      id: '7b8f9e61-3d2a-4a5b-b1c2-d3e4f5a6b7c8',
      roomCode: 'AG-302',
      monthlyRent: new Prisma.Decimal('4500000.00'),
      areaM2: new Prisma.Decimal('28.50'),
      maxOccupants: 2,
      occupancyStatus: 'VACANT',
      property: {
        id: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d',
        name: 'Khu trọ An Gia Building',
        address: '285/12 CMT8, Phường 12, Quận 10, TP.HCM',
        propertyAmenities: [
          { amenity: { id: 'uuid-pa-1', name: 'Thang máy' } },
          { amenity: { id: 'uuid-pa-2', name: 'Hầm gửi xe' } },
          { amenity: { id: 'uuid-shared', name: 'Wifi tốc độ cao' } },
        ],
      },
      images: [
        { imageUrl: 'https://storage.rentmate.vn/rooms/ag-302-cover.jpg' },
        { imageUrl: 'https://storage.rentmate.vn/rooms/ag-302-interior.jpg' },
      ],
      roomAmenities: [
        { amenity: { id: 'uuid-ra-1', name: 'Máy lạnh Inverter' } },
        { amenity: { id: 'uuid-shared', name: 'Wifi tốc độ cao' } }, // trùng với toà nhà
        { amenity: { id: 'uuid-ra-2', name: 'Ban công riêng' } },
      ],
    };

    const card = mapToRoomCardDTO(mockRecord);

    assert.equal(card.roomId, '7b8f9e61-3d2a-4a5b-b1c2-d3e4f5a6b7c8');
    assert.equal(card.roomCode, 'AG-302');
    assert.equal(card.title, 'Khu trọ An Gia Building - Phòng AG-302');
    assert.equal(card.monthlyRent, 4500000);
    assert.equal(card.areaM2, 28.5);
    assert.equal(card.maxOccupants, 2);
    assert.equal(card.occupancyStatus, 'VACANT');
    // FIX-02 Assertion: RoomCard chọn chính xác ảnh đầu tiên trong mảng ảnh đã sắp xếp
    assert.equal(card.coverImageUrl, 'https://storage.rentmate.vn/rooms/ag-302-cover.jpg');
    assert.notEqual(card.coverImageUrl, 'https://storage.rentmate.vn/rooms/ag-302-interior.jpg');
    assert.equal(card.address, '285/12 CMT8, Phường 12, Quận 10, TP.HCM');
    assert.equal(card.propertyId, 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d');
    assert.equal(card.propertyName, 'Khu trọ An Gia Building');

    // Tiện ích tối đa 4, ưu tiên phòng trước, đã lọc trùng Wifi
    assert.equal(card.amenities.length, 4);
    assert.deepEqual(card.amenities, [
      'Ban công riêng',
      'Máy lạnh Inverter',
      'Wifi tốc độ cao',
      'Hầm gửi xe',
    ]);
  });

  test('mapToRoomCardDTO trả coverImageUrl = null và amenities = [] khi không có ảnh/tiện ích', () => {
    const mockRecord: PrismaRoomCardRecord = {
      id: '7b8f9e61-3d2a-4a5b-b1c2-d3e4f5a6b7c8',
      roomCode: 'P-101',
      monthlyRent: new Prisma.Decimal('3000000'),
      areaM2: new Prisma.Decimal('20.00'),
      maxOccupants: 1,
      occupancyStatus: 'VACANT',
      property: {
        id: 'prop-uuid',
        name: 'Nhà trọ Bình Dân',
        address: '123 Đường X, TP.HCM',
        propertyAmenities: [],
      },
      images: [],
      roomAmenities: [],
    };

    const card = mapToRoomCardDTO(mockRecord);
    // FIX-02 Assertion: Không có ảnh trả null
    assert.equal(card.coverImageUrl, null);
    assert.deepEqual(card.amenities, []);
  });

  test('mapToPublicRoomDetailDTO giữ đúng thứ tự ảnh và bảo đảm không rò rỉ dữ liệu nhạy cảm Chủ trọ', () => {
    const mockDetail: PrismaRoomDetailRecord = {
      id: '7b8f9e61-3d2a-4a5b-b1c2-d3e4f5a6b7c8',
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
      images: [
        { id: 'img-1', imageUrl: 'https://img.rentmate.vn/1.jpg', sortOrder: 0 },
        { id: 'img-2', imageUrl: 'https://img.rentmate.vn/2.jpg', sortOrder: 1 },
        { id: 'img-3', imageUrl: 'https://img.rentmate.vn/3.jpg', sortOrder: 2 },
      ],
      roomAmenities: [
        { amenity: { id: 'a-1', name: 'Máy lạnh' } },
      ],
      serviceFees: [
        { id: 'fee-1', feeName: 'Phí dịch vụ chung', monthlyAmount: new Prisma.Decimal('150000'), isRequired: true },
      ],
      property: {
        id: 'prop-1',
        name: 'Khu trọ An Gia Building',
        address: '285/12 CMT8, Phường 12, Quận 10, TP.HCM',
        houseRules: 'Giờ giấc tự do 24/7',
        coverImageUrl: 'https://img.rentmate.vn/prop.jpg',
        propertyAmenities: [
          { amenity: { id: 'a-2', name: 'Thang máy' } },
        ],
        landlord: {
          id: 'user-landlord-uuid',
          fullName: 'Nguyễn Văn An',
          landlordApplicationsAsApplicant: [{ id: 'app-approved-uuid' }],
        },
      },
    };

    const detail = mapToPublicRoomDetailDTO(mockDetail, 16, 3);

    // Kiểm tra cấu trúc chung
    assert.equal(detail.roomId, '7b8f9e61-3d2a-4a5b-b1c2-d3e4f5a6b7c8');
    assert.equal(detail.title, 'Khu trọ An Gia Building - Phòng AG-302');
    assert.equal(detail.description, null);
    assert.equal(detail.floor, 3);
    assert.equal(detail.pricing.monthlyRent, 4500000);
    assert.equal(detail.pricing.depositRequired, 4500000);
    assert.equal(detail.pricing.electricityRate, 3800);
    assert.equal(detail.pricing.waterRate, 25000);
    assert.equal(detail.property.summary.totalRooms, 16);
    assert.equal(detail.property.summary.vacantRooms, 3);

    // FIX-02 Assertions: Thứ tự và trường của danh sách ảnh phòng
    assert.equal(detail.images.length, 3);
    assert.equal(detail.images[0].id, 'img-1');
    assert.equal(detail.images[0].imageUrl, 'https://img.rentmate.vn/1.jpg');
    assert.equal(detail.images[0].sortOrder, 0);

    assert.equal(detail.images[1].id, 'img-2');
    assert.equal(detail.images[1].imageUrl, 'https://img.rentmate.vn/2.jpg');
    assert.equal(detail.images[1].sortOrder, 1);

    assert.equal(detail.images[2].id, 'img-3');
    assert.equal(detail.images[2].imageUrl, 'https://img.rentmate.vn/3.jpg');
    assert.equal(detail.images[2].sortOrder, 2);

    // BẢO MẬT: Kiểm tra LandlordPublicDTO
    assert.equal(detail.landlord.id, 'user-landlord-uuid');
    assert.equal(detail.landlord.fullName, 'Nguyễn Văn An');
    assert.equal(detail.landlord.isVerified, true);

    // Xác minh không có bất kỳ trường nhạy cảm nào lọt vào landlord object
    const landlordKeys = Object.keys(detail.landlord);
    assert.deepEqual(landlordKeys, ['id', 'fullName', 'isVerified']);
    assert.equal((detail.landlord as Record<string, unknown>).phone, undefined);
    assert.equal((detail.landlord as Record<string, unknown>).email, undefined);
    assert.equal((detail.landlord as Record<string, unknown>).passwordHash, undefined);
  });

  test('mapToPublicRoomDetailDTO trả images = [] khi phòng không có ảnh', () => {
    const mockDetailNoImages: PrismaRoomDetailRecord = {
      id: '7b8f9e61-3d2a-4a5b-b1c2-d3e4f5a6b7c8',
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
      images: [],
      roomAmenities: [],
      serviceFees: [],
      property: {
        id: 'prop-1',
        name: 'Khu trọ An Gia Building',
        address: '285/12 CMT8, Phường 12, Quận 10, TP.HCM',
        houseRules: null,
        coverImageUrl: null,
        propertyAmenities: [],
        landlord: {
          id: 'user-landlord-uuid',
          fullName: 'Nguyễn Văn An',
          landlordApplicationsAsApplicant: [],
        },
      },
    };

    const detail = mapToPublicRoomDetailDTO(mockDetailNoImages, 1, 1);
    // FIX-02 Assertion: Không có ảnh trả mảng rỗng []
    assert.deepEqual(detail.images, []);
    assert.equal(detail.landlord.isVerified, false);
  });
});
