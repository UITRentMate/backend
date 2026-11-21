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
const mockImageId = '550e8400-e29b-41d4-a716-446655440030';

const sampleRoomImage = {
  id: mockImageId,
  roomId: mockRoomId,
  imageUrl: 'https://res.cloudinary.com/test-cloud/image/upload/v1/rentmate/rooms/r-1/img-123.webp',
  sortOrder: 1,
  createdAt: new Date(),
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

describe('DELETE /api/v1/landlord/rooms/:roomId/images/:imageId', () => {
  test('returns 401 UNAUTHORIZED when no token provided', async () => {
    const { response, body } = await request(`/api/v1/landlord/rooms/${mockRoomId}/images/${mockImageId}`, {
      method: 'DELETE',
    });

    assert.equal(response.status, 401);
    assert.equal(body.code, 'UNAUTHORIZED');
  });

  test('returns 403 FORBIDDEN when user is TENANT', async () => {
    stub(prisma.user, 'findUnique', async () => mockTenant);

    const { response, body } = await request(`/api/v1/landlord/rooms/${mockRoomId}/images/${mockImageId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${signAccessToken(mockTenant.id)}`,
      },
    });

    assert.equal(response.status, 403);
    assert.equal(body.code, 'FORBIDDEN');
  });

  test('returns 400 VALIDATION_ERROR when imageId is not a UUID', async () => {
    stub(prisma.user, 'findUnique', async () => mockLandlord);

    const { response, body } = await request(`/api/v1/landlord/rooms/${mockRoomId}/images/invalid-uuid`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
      },
    });

    assert.equal(response.status, 400);
    assert.equal(body.code, 'VALIDATION_ERROR');
  });

  test('returns 404 ROOM_NOT_FOUND (anti-enumeration) when room belongs to another landlord', async () => {
    stub(prisma.user, 'findUnique', async () => mockOtherLandlord);
    stub(prisma.room, 'count', async () => 0);

    const { response, body } = await request(`/api/v1/landlord/rooms/${mockRoomId}/images/${mockImageId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${signAccessToken(mockOtherLandlord.id)}`,
      },
    });

    assert.equal(response.status, 404);
    assert.equal(body.code, 'ROOM_NOT_FOUND');
  });

  test('returns 404 IMAGE_NOT_FOUND when image does not exist in room', async () => {
    stub(prisma.user, 'findUnique', async () => mockLandlord);
    stub(prisma.room, 'count', async () => 1);
    stub(prisma.roomImage, 'findFirst', async () => null);

    const { response, body } = await request(`/api/v1/landlord/rooms/${mockRoomId}/images/${mockImageId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
      },
    });

    assert.equal(response.status, 404);
    assert.equal(body.code, 'IMAGE_NOT_FOUND');
  });

  test('returns 200 OK and deletes image from DB and Cloudinary', async () => {
    stub(prisma.user, 'findUnique', async () => mockLandlord);
    stub(prisma.room, 'count', async () => 1);
    stub(prisma.roomImage, 'findFirst', async () => sampleRoomImage);

    let dbDeletedId: string | null = null;
    stub(prisma.roomImage, 'delete', async (args: any) => {
      dbDeletedId = args.where.id;
      return sampleRoomImage;
    });

    let cloudinaryDeletedPublicId: string | null = null;
    stub(mediaService, 'deleteResource', async (publicId: string) => {
      cloudinaryDeletedPublicId = publicId;
      return true;
    });

    const { response, body } = await request(`/api/v1/landlord/rooms/${mockRoomId}/images/${mockImageId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
      },
    });

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(dbDeletedId, mockImageId);
    assert.equal(cloudinaryDeletedPublicId, 'rentmate/rooms/r-1/img-123');
  });

  test('returns 200 OK even if Cloudinary deleteResource throws (DB is Source of Truth)', async () => {
    stub(prisma.user, 'findUnique', async () => mockLandlord);
    stub(prisma.room, 'count', async () => 1);
    stub(prisma.roomImage, 'findFirst', async () => sampleRoomImage);

    stub(prisma.roomImage, 'delete', async () => sampleRoomImage);
    stub(mediaService, 'deleteResource', async () => {
      throw new Error('Cloudinary timeout');
    });

    const { response, body } = await request(`/api/v1/landlord/rooms/${mockRoomId}/images/${mockImageId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
      },
    });

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
  });
});
