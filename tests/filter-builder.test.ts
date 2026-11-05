import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import {
  RoomRepository,
  PUBLIC_ROOM_VISIBILITY_WHERE,
  ROOM_IMAGE_ORDER_BY,
  ROOM_CARD_SELECT,
  ROOM_DETAIL_SELECT,
} from '../src/modules/rooms/room.repository';

describe('RoomRepository Criteria & Query Builder Tests', () => {
  test('Public visibility: 5 điều kiện bắt buộc luôn có mặt ở điều kiện đầu tiên của where', () => {
    // 1. Kiểm tra hằng số production trong Repository
    assert.equal(PUBLIC_ROOM_VISIBILITY_WHERE.occupancyStatus, 'VACANT');
    assert.equal(PUBLIC_ROOM_VISIBILITY_WHERE.visibilityStatus, 'VISIBLE');
    assert.equal(PUBLIC_ROOM_VISIBILITY_WHERE.isArchived, false);
    assert.equal(PUBLIC_ROOM_VISIBILITY_WHERE.property?.status, 'ACTIVE');
    assert.equal(PUBLIC_ROOM_VISIBILITY_WHERE.property?.landlord?.accountStatus, 'ACTIVE');

    // 2. Kiểm tra khi gọi RoomRepository.buildSearchWhere({})
    const where = RoomRepository.buildSearchWhere({});
    const andList = where.AND as Prisma.RoomWhereInput[];
    assert(Array.isArray(andList));
    assert.equal(andList.length, 1);
    assert.deepEqual(andList[0], PUBLIC_ROOM_VISIBILITY_WHERE);
  });

  test('Keyword được bọc trong khối OR trên 3 trường: roomCode, property.name, property.address', () => {
    const where = RoomRepository.buildSearchWhere({ keyword: 'CMT8' });
    const andList = where.AND as Prisma.RoomWhereInput[];
    assert.equal(andList.length, 2);

    const kwCondition = andList[1];
    assert(Array.isArray(kwCondition.OR));
    assert.equal(kwCondition.OR.length, 3);
    assert.deepEqual(kwCondition.OR[0], { roomCode: { contains: 'CMT8', mode: 'insensitive' } });
    assert.deepEqual(kwCondition.OR[1], { property: { name: { contains: 'CMT8', mode: 'insensitive' } } });
    assert.deepEqual(kwCondition.OR[2], { property: { address: { contains: 'CMT8', mode: 'insensitive' } } });
  });

  test('Location AND: Kết hợp province và district không bị ghi đè lẫn nhau', () => {
    const where = RoomRepository.buildSearchWhere({ province: 'TP.HCM', district: 'Quận 10' });
    const andList = where.AND as Prisma.RoomWhereInput[];
    assert.equal(andList.length, 3);

    const provCond = andList[1];
    assert.deepEqual(provCond, {
      property: { address: { contains: 'TP.HCM', mode: 'insensitive' } },
    });

    const distCond = andList[2];
    assert.deepEqual(distCond, {
      property: { address: { contains: 'Quận 10', mode: 'insensitive' } },
    });
  });

  test('Numeric filters: Khoảng giá, diện tích và sức chứa tạo đúng điều kiện gte / lte', () => {
    const where = RoomRepository.buildSearchWhere({
      minPrice: 3000000,
      maxPrice: 5000000,
      minArea: 20,
      maxArea: 40,
      capacity: 2,
    });
    const andList = where.AND as Prisma.RoomWhereInput[];
    assert.equal(andList.length, 6); // 1 vis + 5 numeric

    assert.deepEqual(andList[1], { monthlyRent: { gte: 3000000 } });
    assert.deepEqual(andList[2], { monthlyRent: { lte: 5000000 } });
    assert.deepEqual(andList[3], { areaM2: { gte: 20 } });
    assert.deepEqual(andList[4], { areaM2: { lte: 40 } });
    assert.deepEqual(andList[5], { maxOccupants: { gte: 2 } });
  });

  test('Amenities filter: mỗi tiện ích tạo một điều kiện OR (Room OR Property) trong danh sách AND', () => {
    const a1 = 'e1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c';
    const a2 = 'e4a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5f';
    const where = RoomRepository.buildSearchWhere({ amenities: [a1, a2] });
    const andList = where.AND as Prisma.RoomWhereInput[];
    assert.equal(andList.length, 3); // 1 public vis + 2 amenities

    // Amenity 1
    const condA1 = andList[1];
    assert(Array.isArray(condA1.OR));
    assert.deepEqual(condA1.OR[0], { roomAmenities: { some: { amenityId: a1 } } });
    assert.deepEqual(condA1.OR[1], { property: { propertyAmenities: { some: { amenityId: a1 } } } });

    // Amenity 2
    const condA2 = andList[2];
    assert(Array.isArray(condA2.OR));
    assert.deepEqual(condA2.OR[0], { roomAmenities: { some: { amenityId: a2 } } });
    assert.deepEqual(condA2.OR[1], { property: { propertyAmenities: { some: { amenityId: a2 } } } });
  });

  test('Combined filters: Tất cả các bộ lọc kết hợp đồng thời không bị xung đột hay ghi đè', () => {
    const a1 = 'e1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c';
    const where = RoomRepository.buildSearchWhere({
      keyword: 'Ban công',
      province: 'TP.HCM',
      district: 'Quận 3',
      minPrice: 3000000,
      maxPrice: 6000000,
      minArea: 25,
      maxArea: 50,
      capacity: 2,
      amenities: [a1],
    });

    const andList = where.AND as Prisma.RoomWhereInput[];
    // 1 vis + 1 keyword + 2 location + 5 numeric + 1 amenity = 10 conditions in AND
    assert.equal(andList.length, 10);
    assert.deepEqual(andList[0], PUBLIC_ROOM_VISIBILITY_WHERE);
    assert(andList[1].OR !== undefined); // keyword
    assert(andList[2].property?.address !== undefined); // province
    assert(andList[3].property?.address !== undefined); // district
    assert.deepEqual(andList[4], { monthlyRent: { gte: 3000000 } });
    assert.deepEqual(andList[5], { monthlyRent: { lte: 6000000 } });
    assert.deepEqual(andList[6], { areaM2: { gte: 25 } });
    assert.deepEqual(andList[7], { areaM2: { lte: 50 } });
    assert.deepEqual(andList[8], { maxOccupants: { gte: 2 } });
    assert(andList[9].OR !== undefined); // amenity
  });

  test('Image ordering contract: Query hình ảnh phòng sử dụng chính xác sortOrder ASC, id ASC', () => {
    assert.deepEqual(ROOM_IMAGE_ORDER_BY, [
      { sortOrder: 'asc' },
      { id: 'asc' },
    ]);
  });

  test('Sorting tie-breaker: Mọi tùy chọn sắp xếp luôn đính kèm id ASC', () => {
    const sorts = ['newest', 'price_asc', 'price_desc', 'area_asc', 'area_desc'] as const;
    for (const s of sorts) {
      const orderBy = RoomRepository.buildSearchOrderBy(s);
      assert(Array.isArray(orderBy));
      assert.equal(orderBy.length, 2);
      assert.deepEqual(orderBy[1], { id: 'asc' });
    }
  });

  test('Security Allowlist: Prisma Select không chứa passwordHash, phone, email, CCCD', () => {
    // 1. Kiểm tra ROOM_CARD_SELECT
    const cardSelectJson = JSON.stringify(ROOM_CARD_SELECT);
    assert(!cardSelectJson.includes('passwordHash'));
    assert(!cardSelectJson.includes('phone'));
    assert(!cardSelectJson.includes('email'));
    assert(!cardSelectJson.includes('cccd'));

    // 2. Kiểm tra ROOM_DETAIL_SELECT
    const detailSelectJson = JSON.stringify(ROOM_DETAIL_SELECT);
    assert(!detailSelectJson.includes('passwordHash'));
    assert(!detailSelectJson.includes('phone'));
    assert(!detailSelectJson.includes('email'));
    assert(!detailSelectJson.includes('cccd'));
    // Chỉ select id, fullName và đơn duyệt
    assert(ROOM_DETAIL_SELECT.property.select.landlord.select.id === true);
    assert(ROOM_DETAIL_SELECT.property.select.landlord.select.fullName === true);
  });
});
