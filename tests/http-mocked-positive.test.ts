import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { type AddressInfo } from 'node:net';
import { app } from '../src/app';
import { RoomService } from '../src/modules/rooms/room.service';
import { ApiError } from '../src/common/errors/api-error';
import {
  type PaginatedRoomResponse,
  type PublicRoomDetailDTO,
} from '../src/modules/rooms/room.types';

let server: http.Server;
let baseUrl: string;

// Lưu lại các phương thức gốc của RoomService để khôi phục sau test
const originalSearchRooms = RoomService.searchRooms;
const originalGetPublicRoomDetail = RoomService.getPublicRoomDetail;

describe('Mocked HTTP Positive-Path & Edge Cases Integration Tests', () => {
  before(async () => {
    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    // Khôi phục phương thức gốc
    RoomService.searchRooms = originalSearchRooms;
    RoomService.getPublicRoomDetail = originalGetPublicRoomDetail;

    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  test('SEARCH-01 Positive Path: Trả danh sách phòng không rỗng kèm đầy đủ trường DTO', async () => {
    const mockResponse: PaginatedRoomResponse = {
      items: [
        {
          roomId: '7b8f9e61-3d2a-4a5b-b1c2-d3e4f5a6b7c8',
          roomCode: 'AG-302',
          title: 'Khu trọ An Gia Building - Phòng AG-302',
          monthlyRent: 4500000,
          areaM2: 28.0,
          maxOccupants: 2,
          occupancyStatus: 'VACANT',
          coverImageUrl: 'https://storage.rentmate.vn/rooms/ag-302-cover.jpg',
          address: '285/12 CMT8, Phường 12, Quận 10, TP.HCM',
          propertyId: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d',
          propertyName: 'Khu trọ An Gia Building',
          amenities: ['Máy lạnh Inverter', 'Ban công riêng', 'Thang máy'],
        },
        {
          roomId: '8c9d0e1f-4a3b-4b6c-82d3-e4f5a6b7c8d9',
          roomCode: 'CMT-201',
          title: 'Nhà trọ CMT8 Xanh - Phòng CMT-201',
          monthlyRent: 3800000,
          areaM2: 24.5,
          maxOccupants: 2,
          occupancyStatus: 'VACANT',
          coverImageUrl: 'https://storage.rentmate.vn/rooms/cmt-201-cover.jpg',
          address: '450 CMT8, Phường 11, Quận 3, TP.HCM',
          propertyId: 'b2c3d4e5-f6a7-4b9c-8d1e-2f3a4b5c6d7e',
          propertyName: 'Nhà trọ CMT8 Xanh',
          amenities: ['Wifi tốc độ cao', 'Máy giặt riêng'],
        },
      ],
      page: 1,
      pageSize: 12,
      totalItems: 2,
      totalPages: 1,
    };

    // Stub RoomService.searchRooms
    RoomService.searchRooms = async () => mockResponse;

    const res = await fetch(
      `${baseUrl}/api/v1/rooms/search?keyword=CMT8&province=TP.HCM&district=Quận%2010&minPrice=3000000&maxPrice=5000000`
    );
    assert.equal(res.status, 200);

    const body = (await res.json()) as PaginatedRoomResponse;
    assert.equal(body.items.length, 2);
    assert.equal(body.page, 1);
    assert.equal(body.pageSize, 12);
    assert.equal(body.totalItems, 2);
    assert.equal(body.totalPages, 1);

    const item1 = body.items[0];
    assert.equal(item1.roomId, '7b8f9e61-3d2a-4a5b-b1c2-d3e4f5a6b7c8');
    assert.equal(item1.roomCode, 'AG-302');
    assert.equal(item1.monthlyRent, 4500000);
    assert.equal(item1.areaM2, 28.0);
    assert.equal(item1.occupancyStatus, 'VACANT');
    assert.equal(item1.coverImageUrl, 'https://storage.rentmate.vn/rooms/ag-302-cover.jpg');
    assert.deepEqual(item1.amenities, ['Máy lạnh Inverter', 'Ban công riêng', 'Thang máy']);
  });

  test('SEARCH-02 Positive Path: Trả HTTP 200 chi tiết phòng đầy đủ và bảo mật dữ liệu chủ trọ', async () => {
    const validRoomId = '7b8f9e61-3d2a-4a5b-b1c2-d3e4f5a6b7c8';
    const mockDetail: PublicRoomDetailDTO = {
      roomId: validRoomId,
      roomCode: 'AG-302',
      title: 'Khu trọ An Gia Building - Phòng AG-302',
      description: null,
      areaM2: 28.0,
      maxOccupants: 2,
      floor: 3,
      occupancyStatus: 'VACANT',
      createdAt: '2026-10-30T10:15:30.000Z',
      pricing: {
        monthlyRent: 4500000,
        depositRequired: 4500000,
        electricityRate: 3800,
        waterRate: 25000,
      },
      images: [
        {
          id: '11111111-2222-4333-8444-555555555555',
          imageUrl: 'https://storage.rentmate.vn/rooms/ag-302-cover.jpg',
          sortOrder: 0,
        },
        {
          id: '22222222-3333-4444-8555-666666666666',
          imageUrl: 'https://storage.rentmate.vn/rooms/ag-302-balcony.jpg',
          sortOrder: 1,
        },
      ],
      amenities: {
        roomAmenities: [
          { id: 'e1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c', name: 'Máy lạnh Inverter' },
          { id: 'e2a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5d', name: 'Ban công riêng' },
        ],
        propertyAmenities: [
          { id: 'e4a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5f', name: 'Thang máy' },
        ],
      },
      serviceFees: [
        {
          id: 'd1c2b3a4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
          feeName: 'Phí quản lý & dịch vụ chung',
          monthlyAmount: 150000,
          isRequired: true,
        },
      ],
      property: {
        id: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d',
        name: 'Khu trọ An Gia Building',
        address: '285/12 CMT8, Phường 12, Quận 10, TP.HCM',
        houseRules: 'Giờ giấc tự do 24/7',
        coverImageUrl: 'https://storage.rentmate.vn/properties/an-gia-building.jpg',
        summary: {
          totalRooms: 16,
          vacantRooms: 3,
        },
      },
      landlord: {
        id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        fullName: 'Nguyễn Văn An',
        isVerified: true,
      },
    };

    RoomService.getPublicRoomDetail = async (id: string) => {
      assert.equal(id, validRoomId);
      return mockDetail;
    };

    const res = await fetch(`${baseUrl}/api/v1/public/rooms/${validRoomId}`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as PublicRoomDetailDTO;
    assert.equal(body.roomId, validRoomId);
    assert.equal(body.title, 'Khu trọ An Gia Building - Phòng AG-302');
    assert.equal(body.description, null);
    assert.equal(body.pricing.monthlyRent, 4500000);
    assert.equal(body.images.length, 2);
    // FIX-02 Assertion: Kiểm tra chi tiết mảng images giữ đúng id, url và sortOrder từ Service
    assert.equal(body.images[0].id, '11111111-2222-4333-8444-555555555555');
    assert.equal(body.images[0].imageUrl, 'https://storage.rentmate.vn/rooms/ag-302-cover.jpg');
    assert.equal(body.images[0].sortOrder, 0);
    assert.equal(body.images[1].id, '22222222-3333-4444-8555-666666666666');
    assert.equal(body.images[1].imageUrl, 'https://storage.rentmate.vn/rooms/ag-302-balcony.jpg');
    assert.equal(body.images[1].sortOrder, 1);
    assert.equal(body.amenities.roomAmenities.length, 2);
    assert.equal(body.amenities.propertyAmenities.length, 1);
    assert.equal(body.property.summary.totalRooms, 16);
    assert.equal(body.property.summary.vacantRooms, 3);

    // KIỂM TRA BẢO MẬT TUYỆT ĐỐI TRÊN HTTP JSON RESPONSE
    assert.deepEqual(Object.keys(body.landlord), ['id', 'fullName', 'isVerified']);
    assert.equal((body.landlord as Record<string, unknown>).phone, undefined);
    assert.equal((body.landlord as Record<string, unknown>).email, undefined);
    assert.equal((body.landlord as Record<string, unknown>).passwordHash, undefined);
    assert.equal((body.landlord as Record<string, unknown>).cccd, undefined);
  });

  test('SEARCH-02 Edge Case: Phòng HIDDEN / Bị khóa -> Trả 404 ROOM_NOT_FOUND', async () => {
    const hiddenRoomId = '7b8f9e61-3d2a-4a5b-b1c2-d3e4f5a6b7c9';

    // Giả lập Service từ chối phòng vì vi phạm điều kiện Public Visibility
    RoomService.getPublicRoomDetail = async () => {
      throw new ApiError(
        404,
        'ROOM_NOT_FOUND',
        'Phòng trọ không tồn tại hoặc hiện không khả dụng công khai'
      );
    };

    const res = await fetch(`${baseUrl}/api/v1/public/rooms/${hiddenRoomId}`);
    assert.equal(res.status, 404);

    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.success, false);
    assert.equal(body.code, 'ROOM_NOT_FOUND');
    assert.equal(body.message, 'Phòng trọ không tồn tại hoặc hiện không khả dụng công khai');
    assert.equal(typeof body.traceId, 'string');
  });

  test('SEARCH-01 Edge Case: Khi totalItems = 0 thì totalPages = 0', async () => {
    const emptyResponse: PaginatedRoomResponse = {
      items: [],
      page: 1,
      pageSize: 12,
      totalItems: 0,
      totalPages: 0,
    };

    RoomService.searchRooms = async () => emptyResponse;

    const res = await fetch(`${baseUrl}/api/v1/rooms/search?keyword=KhongCoPhongNaoNhuNay`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as PaginatedRoomResponse;
    assert.equal(body.items.length, 0);
    assert.equal(body.totalItems, 0);
    assert.equal(body.totalPages, 0);
  });
});
