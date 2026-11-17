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

const mockPropertyId = '550e8400-e29b-41d4-a716-446655440010';

const sampleProperty = {
  id: mockPropertyId,
  landlordId: mockLandlord.id,
  name: 'Nhà trọ Hưng Thịnh',
  address: '123 Đỗ Xuân Hợp',
  houseRules: 'Nội quy',
  coverImageUrl: 'https://res.cloudinary.com/test-cloud/image/upload/v1/rentmate/properties/prop-1/cover_old.jpg',
  status: 'ACTIVE',
  createdAt: new Date(),
  updatedAt: new Date(),
  propertyAmenities: [],
  rooms: [],
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

describe('POST /api/v1/landlord/properties/:propertyId/cover-image', () => {
  test('returns 401 UNAUTHORIZED when no token provided', async () => {
    const { response, body } = await request(`/api/v1/landlord/properties/${mockPropertyId}/cover-image`, {
      method: 'POST',
    });

    assert.equal(response.status, 401);
    assert.equal(body.code, 'UNAUTHORIZED');
  });

  test('returns 403 FORBIDDEN when user is TENANT', async () => {
    stub(prisma.user, 'findUnique', async () => mockTenant);

    const { response, body } = await request(`/api/v1/landlord/properties/${mockPropertyId}/cover-image`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(mockTenant.id)}`,
      },
    });

    assert.equal(response.status, 403);
    assert.equal(body.code, 'FORBIDDEN');
  });

  test('returns 404 NOT_FOUND (anti-enumeration) when property belongs to another landlord', async () => {
    stub(prisma.user, 'findUnique', async () => mockOtherLandlord);
    stub(prisma.property, 'findUnique', async () => sampleProperty);

    const formData = new FormData();
    const file = new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], { type: 'image/jpeg' });
    formData.append('coverImage', file, 'cover.jpg');

    const { response, body } = await request(`/api/v1/landlord/properties/${mockPropertyId}/cover-image`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(mockOtherLandlord.id)}`,
      },
      body: formData,
    });

    assert.equal(response.status, 404);
    assert.equal(body.code, 'PROPERTY_NOT_FOUND');
  });

  test('returns 400 FILE_REQUIRED when request has no file', async () => {
    stub(prisma.user, 'findUnique', async () => mockLandlord);
    stub(prisma.property, 'findUnique', async () => sampleProperty);

    const formData = new FormData();

    const { response, body } = await request(`/api/v1/landlord/properties/${mockPropertyId}/cover-image`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
      },
      body: formData,
    });

    assert.equal(response.status, 400);
    assert.equal(body.code, 'FILE_REQUIRED');
  });

  test('returns 415 UNSUPPORTED_MEDIA_TYPE when file has fake extension but invalid magic bytes', async () => {
    stub(prisma.user, 'findUnique', async () => mockLandlord);
    stub(prisma.property, 'findUnique', async () => sampleProperty);

    const formData = new FormData();
    const fakeFile = new Blob([Buffer.from('this is not an image binary')], { type: 'image/jpeg' });
    formData.append('coverImage', fakeFile, 'fake.jpg');

    const { response, body } = await request(`/api/v1/landlord/properties/${mockPropertyId}/cover-image`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
      },
      body: formData,
    });

    assert.equal(response.status, 415);
    assert.equal(body.code, 'UNSUPPORTED_MEDIA_TYPE');
  });

  test('returns 200 OK, uploads to Cloudinary, updates DB, and triggers old cover cleanup', async () => {
    stub(prisma.user, 'findUnique', async () => mockLandlord);
    stub(prisma.property, 'findUnique', async () => sampleProperty);

    let deletedOldPublicId: string | null = null;
    stub(mediaService, 'uploadStream', async () => ({
      secureUrl: 'https://res.cloudinary.com/test-cloud/image/upload/v2/rentmate/properties/prop-1/cover_new.webp',
      publicId: 'rentmate/properties/prop-1/cover_new',
    }));
    stub(mediaService, 'deleteResource', async (publicId: string) => {
      deletedOldPublicId = publicId;
      return true;
    });

    let dbUpdatedUrl = '';
    stub(prisma.property, 'update', async (args: any) => {
      dbUpdatedUrl = args.data.coverImageUrl;
      return {
        id: mockPropertyId,
        name: sampleProperty.name,
        coverImageUrl: dbUpdatedUrl,
      };
    });

    const formData = new FormData();
    const validJpeg = new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], { type: 'image/jpeg' });
    formData.append('coverImage', validJpeg, 'cover.jpg');

    const { response, body } = await request(`/api/v1/landlord/properties/${mockPropertyId}/cover-image`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
      },
      body: formData,
    });

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.coverImageUrl, 'https://res.cloudinary.com/test-cloud/image/upload/v2/rentmate/properties/prop-1/cover_new.webp');
    assert.equal(dbUpdatedUrl, 'https://res.cloudinary.com/test-cloud/image/upload/v2/rentmate/properties/prop-1/cover_new.webp');
    assert.equal(deletedOldPublicId, 'rentmate/properties/prop-1/cover_old');
  });

  test('compensates by calling deleteResource on new image if DB update throws error', async () => {
    stub(prisma.user, 'findUnique', async () => mockLandlord);
    stub(prisma.property, 'findUnique', async () => sampleProperty);

    let compensatedPublicId: string | null = null;
    stub(mediaService, 'uploadStream', async () => ({
      secureUrl: 'https://res.cloudinary.com/test-cloud/image/upload/v2/rentmate/properties/prop-1/cover_new.webp',
      publicId: 'rentmate/properties/prop-1/cover_new',
    }));
    stub(mediaService, 'deleteResource', async (publicId: string) => {
      compensatedPublicId = publicId;
      return true;
    });

    stub(prisma.property, 'update', async () => {
      throw new Error('Database connection failed');
    });

    const formData = new FormData();
    const validJpeg = new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], { type: 'image/jpeg' });
    formData.append('coverImage', validJpeg, 'cover.jpg');

    const { response, body } = await request(`/api/v1/landlord/properties/${mockPropertyId}/cover-image`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(mockLandlord.id)}`,
      },
      body: formData,
    });

    assert.equal(response.status, 500);
    assert.equal(compensatedPublicId, 'rentmate/properties/prop-1/cover_new');
  });
});
