import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { afterEach, describe, test } from 'node:test';
import { app } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { signAccessToken } from '../../src/modules/auth/auth.security';
import { mediaService } from '../../src/modules/media/media.service';

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

const mockOtherLandlord = {
  id: '550e8400-e29b-41d4-a716-446655440099',
  role: 'LANDLORD',
  accountStatus: 'ACTIVE',
  fullName: 'Chủ Trọ Khác',
  email: 'khac@example.com',
  phone: '0909999999',
};

const mockTenant = {
  id: '550e8400-e29b-41d4-a716-446655440002',
  role: 'TENANT',
  accountStatus: 'ACTIVE',
  fullName: 'Người Thuê B',
  email: 'tenant@example.com',
  phone: '0907654321',
};

const mockRoomId = '550e8400-e29b-41d4-a716-446655440020';

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

describe('POST /api/v1/landlord/rooms/:roomId/images', () => {
  test('returns 401 UNAUTHORIZED when no token provided', async () => {
    const { response, body } = await request(`/api/v1/landlord/rooms/${mockRoomId}/images`, {
      method: 'POST',
    });

    assert.equal(response.status, 401);
    assert.equal(body.code, 'UNAUTHORIZED');
  });

  test('returns 403 FORBIDDEN when user is TENANT', async () => {
    stub(prisma.user, 'findUnique', async () => mockTenant);

    const { response, body } = await request(`/api/v1/landlord/rooms/${mockRoomId}/images`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(mockTenant.id)}`,
      },
    });

    assert.equal(response.status, 403);
    assert.equal(body.code, 'FORBIDDEN');
  });

  test('returns 404 ROOM_NOT_FOUND (anti-enumeration) when room belongs to another landlord', async () => {
    stub(prisma.user, 'findUnique', async () => mockOtherLandlord);
    stub(prisma.room, 'count', async () => 0);

    const formData = new FormData();
    const file = new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], { type: 'image/jpeg' });
    formData.append('images', file, 'room1.jpg');

    const { response, body } = await request(`/api/v1/landlord/rooms/${mockRoomId}/images`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(mockOtherLandlord.id)}`,
      },
      body: formData,
    });

    assert.equal(response.status, 404);
    assert.equal(body.code, 'ROOM_NOT_FOUND');
  });

  test('returns 400 ROOM_IMAGE_LIMIT_EXCEEDED when room already reached 10 images', async () => {
    stub(prisma.user, 'findUnique', async () => mockLandlord);
    stub(prisma.room, 'count', async () => 1);
    stub(prisma.roomImage, 'count', async () => 10);

    const formData = new FormData();
    const file = new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], { type: 'image/jpeg' });
    formData.append('images', file, 'room1.jpg');

    const { response, body } = await request(`/api/v1/landlord/rooms/${mockRoomId}/images`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
      },
      body: formData,
    });

    assert.equal(response.status, 400);
    assert.equal(body.code, 'ROOM_IMAGE_LIMIT_EXCEEDED');
  });

  test('returns 201 CREATED when all uploaded images succeed', async () => {
    stub(prisma.user, 'findUnique', async () => mockLandlord);
    stub(prisma.room, 'count', async () => 1);
    stub(prisma.roomImage, 'count', async () => 2);
    stub(prisma.roomImage, 'aggregate', async () => ({ _max: { sortOrder: 1 } }));
    stub(prisma, '$transaction', async (fn: any) => fn(prisma));

    let uploadCount = 0;
    stub(mediaService, 'uploadStream', async () => {
      uploadCount++;
      return {
        secureUrl: `https://res.cloudinary.com/test-cloud/image/upload/v1/rentmate/rooms/r-1/img-${uploadCount}.webp`,
        publicId: `rentmate/rooms/r-1/img-${uploadCount}`,
      };
    });

    stub(prisma.roomImage, 'create', async (args: any) => ({
      id: args.data.id ?? 'img-id',
      roomId: mockRoomId,
      imageUrl: args.data.imageUrl,
      sortOrder: args.data.sortOrder,
      createdAt: new Date(),
    }));

    const formData = new FormData();
    const file1 = new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], { type: 'image/jpeg' });
    const file2 = new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' });
    formData.append('images', file1, 'room1.jpg');
    formData.append('images', file2, 'room2.png');

    const { response, body } = await request(`/api/v1/landlord/rooms/${mockRoomId}/images`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
      },
      body: formData,
    });

    assert.equal(response.status, 201);
    assert.equal(body.success, true);
    assert.equal(body.summary.totalRequested, 2);
    assert.equal(body.summary.succeeded, 2);
    assert.equal(body.summary.failed, 0);
    assert.equal(body.summary.remainingSlots, 6);
    assert.equal(body.uploaded.length, 2);
    assert.equal(body.failed.length, 0);
  });

  test('returns 200 OK Partial Success when room slots are exhausted mid-upload', async () => {
    stub(prisma.user, 'findUnique', async () => mockLandlord);
    stub(prisma.room, 'count', async () => 1);
    stub(prisma.roomImage, 'count', async () => 9); // Only 1 slot left!
    stub(prisma.roomImage, 'aggregate', async () => ({ _max: { sortOrder: 8 } }));
    stub(prisma, '$transaction', async (fn: any) => fn(prisma));

    stub(mediaService, 'uploadStream', async () => ({
      secureUrl: 'https://res.cloudinary.com/test-cloud/image/upload/v1/rentmate/rooms/r-1/img-1.webp',
      publicId: 'rentmate/rooms/r-1/img-1',
    }));

    stub(prisma.roomImage, 'create', async (args: any) => ({
      id: 'img-1',
      roomId: mockRoomId,
      imageUrl: args.data.imageUrl,
      sortOrder: args.data.sortOrder,
      createdAt: new Date(),
    }));

    const formData = new FormData();
    const file1 = new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], { type: 'image/jpeg' });
    const file2 = new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], { type: 'image/jpeg' });
    formData.append('images', file1, 'room1.jpg');
    formData.append('images', file2, 'room2.jpg');

    const { response, body } = await request(`/api/v1/landlord/rooms/${mockRoomId}/images`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
      },
      body: formData,
    });

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.summary.totalRequested, 2);
    assert.equal(body.summary.succeeded, 1);
    assert.equal(body.summary.failed, 1);
    assert.equal(body.summary.remainingSlots, 0);
    assert.equal(body.uploaded.length, 1);
    assert.equal(body.failed.length, 1);
    assert.equal(body.failed[0].code, 'ROOM_IMAGE_LIMIT_EXCEEDED');
  });

  test('returns 200 OK Partial Success when one file has invalid magic bytes', async () => {
    stub(prisma.user, 'findUnique', async () => mockLandlord);
    stub(prisma.room, 'count', async () => 1);
    stub(prisma.roomImage, 'count', async () => 0);
    stub(prisma.roomImage, 'aggregate', async () => ({ _max: { sortOrder: -1 } }));
    stub(prisma, '$transaction', async (fn: any) => fn(prisma));

    stub(mediaService, 'uploadStream', async () => ({
      secureUrl: 'https://res.cloudinary.com/test-cloud/image/upload/v1/rentmate/rooms/r-1/img-1.webp',
      publicId: 'rentmate/rooms/r-1/img-1',
    }));

    stub(prisma.roomImage, 'create', async (args: any) => ({
      id: 'img-1',
      roomId: mockRoomId,
      imageUrl: args.data.imageUrl,
      sortOrder: args.data.sortOrder,
      createdAt: new Date(),
    }));

    const formData = new FormData();
    const validFile = new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], { type: 'image/jpeg' });
    const fakeFile = new Blob([Buffer.from('not real binary')], { type: 'image/jpeg' });
    formData.append('images', validFile, 'valid.jpg');
    formData.append('images', fakeFile, 'fake.jpg');

    const { response, body } = await request(`/api/v1/landlord/rooms/${mockRoomId}/images`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
      },
      body: formData,
    });

    assert.equal(response.status, 200);
    assert.equal(body.summary.succeeded, 1);
    assert.equal(body.summary.failed, 1);
    assert.equal(body.failed[0].code, 'UNSUPPORTED_MEDIA_TYPE');
  });

  test('compensates by calling deleteResource if DB insert fails', async () => {
    stub(prisma.user, 'findUnique', async () => mockLandlord);
    stub(prisma.room, 'count', async () => 1);
    stub(prisma.roomImage, 'count', async () => 0);
    stub(prisma.roomImage, 'aggregate', async () => ({ _max: { sortOrder: -1 } }));
    stub(prisma, '$transaction', async (fn: any) => fn(prisma));

    let compensatedPublicId: string | null = null;
    stub(mediaService, 'uploadStream', async () => ({
      secureUrl: 'https://res.cloudinary.com/test-cloud/image/upload/v1/rentmate/rooms/r-1/img-1.webp',
      publicId: 'rentmate/rooms/r-1/img-1',
    }));
    stub(mediaService, 'deleteResource', async (publicId: string) => {
      compensatedPublicId = publicId;
      return true;
    });

    stub(prisma.roomImage, 'create', async () => {
      throw new Error('Database insert failed');
    });

    const formData = new FormData();
    const file = new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], { type: 'image/jpeg' });
    formData.append('images', file, 'room.jpg');

    const { response, body } = await request(`/api/v1/landlord/rooms/${mockRoomId}/images`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
      },
      body: formData,
    });

    assert.equal(response.status, 400); // 0 succeeded -> 400
    assert.equal(body.summary.succeeded, 0);
    assert.equal(body.summary.failed, 1);
    assert.equal(body.failed[0].code, 'DB_INSERT_FAILED');
    assert.equal(compensatedPublicId, 'rentmate/rooms/r-1/img-1');
  });

  test('rejects file with unsupported MIME type even when magic bytes are valid JPEG', async () => {
    stub(prisma.user, 'findUnique', async () => mockLandlord);
    stub(prisma.room, 'count', async () => 1);
    stub(prisma.roomImage, 'count', async () => 0);
    stub(prisma.roomImage, 'aggregate', async () => ({ _max: { sortOrder: -1 } }));
    stub(prisma, '$transaction', async (fn: any) => fn(prisma));

    let uploadStreamCalled = 0;
    stub(mediaService, 'uploadStream', async () => {
      uploadStreamCalled++;
      return {
        secureUrl: 'https://res.cloudinary.com/test-cloud/image/upload/v1/rentmate/rooms/r-1/img-1.webp',
        publicId: 'rentmate/rooms/r-1/img-1',
      };
    });
    stub(prisma.roomImage, 'create', async (args: any) => ({
      id: 'img-1',
      roomId: mockRoomId,
      imageUrl: args.data.imageUrl,
      sortOrder: args.data.sortOrder,
      createdAt: new Date(),
    }));

    const formData = new FormData();
    const validFile = new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], { type: 'image/jpeg' });
    // JPEG binary signature nhưng khai báo MIME type không hợp lệ (image/gif)
    const badMimeFile = new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], { type: 'image/gif' });
    formData.append('images', validFile, 'valid.jpg');
    formData.append('images', badMimeFile, 'disguised.gif');

    const { response, body } = await request(`/api/v1/landlord/rooms/${mockRoomId}/images`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
      },
      body: formData,
    });

    assert.equal(response.status, 200);
    assert.equal(uploadStreamCalled, 1); // Chỉ gọi Cloudinary đúng 1 lần cho file hợp lệ
    assert.equal(body.summary.succeeded, 1);
    assert.equal(body.summary.failed, 1);
    assert.equal(body.failed[0].originalName, 'disguised.gif');
    assert.equal(body.failed[0].code, 'UNSUPPORTED_MEDIA_TYPE');
  });

  test('compensates Cloudinary upload when concurrent batch fills remaining slot before DB insert', async () => {
    stub(prisma.user, 'findUnique', async () => mockLandlord);
    stub(prisma.room, 'count', async () => 1);
    stub(prisma, '$transaction', async (fn: any) => fn(prisma));

    let countCalls = 0;
    stub(prisma.roomImage, 'count', async () => {
      countCalls++;
      // Lần pre-check thấy còn 1 slot (9 ảnh), nhưng khi vào transaction thì request khác đã lấp đầy 10 ảnh
      return countCalls === 1 ? 9 : 10;
    });

    const deletedPublicIds: string[] = [];
    stub(mediaService, 'uploadStream', async () => ({
      secureUrl: 'https://res.cloudinary.com/test-cloud/image/upload/v1/rentmate/rooms/r-1/img-race.webp',
      publicId: 'rentmate/rooms/r-1/img-race',
    }));
    stub(mediaService, 'deleteResource', async (publicId: string) => {
      deletedPublicIds.push(publicId);
      return true;
    });

    const formData = new FormData();
    const file = new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], { type: 'image/jpeg' });
    formData.append('images', file, 'race.jpg');

    const { response, body } = await request(`/api/v1/landlord/rooms/${mockRoomId}/images`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
      },
      body: formData,
    });

    assert.equal(response.status, 400);
    assert.equal(body.summary.succeeded, 0);
    assert.equal(body.summary.failed, 1);
    assert.equal(body.summary.remainingSlots, 0);
    assert.equal(body.failed[0].code, 'ROOM_IMAGE_LIMIT_EXCEEDED');
    assert.deepEqual(deletedPublicIds, ['rentmate/rooms/r-1/img-race']);
  });
});
