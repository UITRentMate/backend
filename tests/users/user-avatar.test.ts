import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, test } from 'node:test';
import { app } from '../../src/app';
import { ApiError } from '../../src/common/errors/api-error';
import { prisma } from '../../src/infrastructure/database/prisma';
import { signAccessToken } from '../../src/modules/auth/auth.security';
import { mediaService } from '../../src/modules/media/media.service';
import { uploadMyAvatar } from '../../src/modules/users/users.service';

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

const VALID_JPEG_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const VALID_PNG_BUFFER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const VALID_WEBP_BUFFER = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

const baseUser = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  fullName: 'Nguyen Van A',
  email: 'a@example.com',
  phone: '0901234567',
  role: 'TENANT',
  accountStatus: 'ACTIVE',
  avatarUrl: 'https://res.cloudinary.com/demo/image/upload/v1/rentmate/avatars/old.webp',
  avatarCloudinaryPublicId: 'rentmate/avatars/550e8400-e29b-41d4-a716-446655440000/avatar_old',
  dateOfBirth: new Date('2000-05-15T00:00:00.000Z'),
  address: 'KTX Khu B ĐHQG, TP. Thủ Đức',
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
    } catch {
      body = {};
    }
    return { response, body };
  } finally {
    server.close();
  }
}

describe('users.service — uploadMyAvatar', () => {
  test('uploads 512x512 face-cropped avatar, updates DB in transaction with FOR UPDATE, returns full UserProfileDTO, and deletes old avatar', async () => {
    let capturedUploadOptions: any;
    let capturedUpdateArgs: any;
    let lockQueryCalled = false;
    const deletedPublicIds: string[] = [];

    stub(prisma.user, 'findUnique', async (args: any) => {
      assert.equal(args.where.id, baseUser.id);
      return {
        id: baseUser.id,
        accountStatus: 'ACTIVE',
        avatarCloudinaryPublicId: baseUser.avatarCloudinaryPublicId,
      };
    });

    stub(mediaService, 'uploadStream', async (buffer: Buffer, options: any) => {
      assert.equal(buffer.equals(VALID_JPEG_BUFFER), true);
      capturedUploadOptions = options;
      return {
        secureUrl: 'https://res.cloudinary.com/demo/image/upload/v2/rentmate/avatars/new.webp',
        publicId: options.publicId,
      };
    });

    const txClient = {
      $queryRaw: async () => {
        lockQueryCalled = true;
        return [
          {
            id: baseUser.id,
            account_status: 'ACTIVE',
            avatar_cloudinary_public_id: baseUser.avatarCloudinaryPublicId,
          },
        ];
      },
      user: {
        update: async (args: any) => {
          assert.equal(args.where.id, baseUser.id);
          capturedUpdateArgs = args;
          return {
            id: baseUser.id,
            fullName: baseUser.fullName,
            email: baseUser.email,
            phone: baseUser.phone,
            role: baseUser.role,
            accountStatus: baseUser.accountStatus,
            avatarUrl: args.data.avatarUrl,
            dateOfBirth: baseUser.dateOfBirth,
            address: baseUser.address,
          };
        },
      },
    };
    stub(prisma, '$transaction', async (callback: any) => callback(txClient));

    stub(mediaService, 'deleteResource', async (publicId: string) => {
      deletedPublicIds.push(publicId);
      return true;
    });

    const result = await uploadMyAvatar(baseUser.id, VALID_JPEG_BUFFER);

    assert.equal(lockQueryCalled, true);
    assert.match(
      capturedUploadOptions.publicId,
      new RegExp(`^rentmate/avatars/${baseUser.id}/avatar_\\d+_[0-9a-f]{8}$`),
    );
    assert.deepEqual(capturedUploadOptions.transformation, {
      width: 512,
      height: 512,
      crop: 'fill',
      gravity: 'face',
    });
    assert.deepEqual(capturedUpdateArgs.data, {
      avatarUrl: 'https://res.cloudinary.com/demo/image/upload/v2/rentmate/avatars/new.webp',
      avatarCloudinaryPublicId: capturedUploadOptions.publicId,
    });
    assert.deepEqual(deletedPublicIds, [baseUser.avatarCloudinaryPublicId]);
    assert.deepEqual(result, {
      userId: baseUser.id,
      fullName: baseUser.fullName,
      email: baseUser.email,
      phone: baseUser.phone,
      role: baseUser.role,
      status: baseUser.accountStatus,
      avatarUrl: 'https://res.cloudinary.com/demo/image/upload/v2/rentmate/avatars/new.webp',
      dateOfBirth: '2000-05-15',
      address: baseUser.address,
    });
    assert.equal('avatarCloudinaryPublicId' in result, false);
    assert.equal('passwordHash' in result, false);
  });

  test('first-time upload when avatarCloudinaryPublicId is null does not call deleteResource', async () => {
    let deleteCalled = false;

    stub(prisma.user, 'findUnique', async () => ({
      id: baseUser.id,
      accountStatus: 'ACTIVE',
      avatarCloudinaryPublicId: null,
    }));

    stub(mediaService, 'uploadStream', async (_buffer: Buffer, options: any) => ({
      secureUrl: 'https://res.cloudinary.com/demo/image/upload/v2/rentmate/avatars/first.webp',
      publicId: options.publicId,
    }));

    const txClient = {
      $queryRaw: async () => [
        {
          id: baseUser.id,
          account_status: 'ACTIVE',
          avatar_cloudinary_public_id: null,
        },
      ],
      user: {
        update: async (args: any) => ({
          id: baseUser.id,
          fullName: baseUser.fullName,
          email: baseUser.email,
          phone: baseUser.phone,
          role: baseUser.role,
          accountStatus: baseUser.accountStatus,
          avatarUrl: args.data.avatarUrl,
          dateOfBirth: null,
          address: null,
        }),
      },
    };
    stub(prisma, '$transaction', async (callback: any) => callback(txClient));

    stub(mediaService, 'deleteResource', async () => {
      deleteCalled = true;
      return true;
    });

    const result = await uploadMyAvatar(baseUser.id, VALID_PNG_BUFFER);
    assert.equal(deleteCalled, false);
    assert.equal(
      result.avatarUrl,
      'https://res.cloudinary.com/demo/image/upload/v2/rentmate/avatars/first.webp',
    );
  });

  test('rolls back newly uploaded Cloudinary asset if DB update fails', async () => {
    const deletedPublicIds: string[] = [];

    stub(prisma.user, 'findUnique', async () => ({
      id: baseUser.id,
      accountStatus: 'ACTIVE',
      avatarCloudinaryPublicId: baseUser.avatarCloudinaryPublicId,
    }));

    stub(mediaService, 'uploadStream', async () => ({
      secureUrl: 'https://res.cloudinary.com/demo/image/upload/v2/rentmate/avatars/new.webp',
      publicId: 'rentmate/avatars/new-public-id',
    }));

    const txClient = {
      $queryRaw: async () => [
        {
          id: baseUser.id,
          account_status: 'ACTIVE',
          avatar_cloudinary_public_id: baseUser.avatarCloudinaryPublicId,
        },
      ],
      user: {
        update: async () => {
          throw new Error('DB update failed');
        },
      },
    };
    stub(prisma, '$transaction', async (callback: any) => callback(txClient));

    stub(mediaService, 'deleteResource', async (publicId: string) => {
      deletedPublicIds.push(publicId);
      return true;
    });

    await assert.rejects(
      () => uploadMyAvatar(baseUser.id, VALID_JPEG_BUFFER),
      { message: 'DB update failed' },
    );

    assert.deepEqual(deletedPublicIds, ['rentmate/avatars/new-public-id']);
  });

  test('maps Prisma P2025 on DB update to 401 UNAUTHORIZED after rolling back Cloudinary asset', async () => {
    const deletedPublicIds: string[] = [];

    stub(prisma.user, 'findUnique', async () => ({
      id: baseUser.id,
      accountStatus: 'ACTIVE',
      avatarCloudinaryPublicId: null,
    }));

    stub(mediaService, 'uploadStream', async () => ({
      secureUrl: 'https://res.cloudinary.com/demo/image/upload/v2/rentmate/avatars/new.webp',
      publicId: 'rentmate/avatars/new-public-id',
    }));

    const txClient = {
      $queryRaw: async () => [
        {
          id: baseUser.id,
          account_status: 'ACTIVE',
          avatar_cloudinary_public_id: null,
        },
      ],
      user: {
        update: async () => {
          throw { code: 'P2025' };
        },
      },
    };
    stub(prisma, '$transaction', async (callback: any) => callback(txClient));

    stub(mediaService, 'deleteResource', async (publicId: string) => {
      deletedPublicIds.push(publicId);
      return true;
    });

    await assert.rejects(
      () => uploadMyAvatar(baseUser.id, VALID_JPEG_BUFFER),
      (err: unknown) =>
        err instanceof ApiError && err.statusCode === 401 && err.code === 'UNAUTHORIZED',
    );

    assert.deepEqual(deletedPublicIds, ['rentmate/avatars/new-public-id']);
  });

  test('TOCTOU: accountStatus becoming LOCKED between pre-check and transaction lock throws 403 ACCOUNT_LOCKED and rolls back newly uploaded asset', async () => {
    const deletedPublicIds: string[] = [];
    let updateCalled = false;

    stub(prisma.user, 'findUnique', async () => ({
      id: baseUser.id,
      accountStatus: 'ACTIVE',
      avatarCloudinaryPublicId: baseUser.avatarCloudinaryPublicId,
    }));

    stub(mediaService, 'uploadStream', async () => ({
      secureUrl: 'https://res.cloudinary.com/demo/image/upload/v2/rentmate/avatars/toctou.webp',
      publicId: 'rentmate/avatars/toctou-public-id',
    }));

    const txClient = {
      $queryRaw: async () => [
        {
          id: baseUser.id,
          account_status: 'LOCKED',
          avatar_cloudinary_public_id: baseUser.avatarCloudinaryPublicId,
        },
      ],
      user: {
        update: async () => {
          updateCalled = true;
          return baseUser;
        },
      },
    };
    stub(prisma, '$transaction', async (callback: any) => callback(txClient));

    stub(mediaService, 'deleteResource', async (publicId: string) => {
      deletedPublicIds.push(publicId);
      return true;
    });

    await assert.rejects(
      () => uploadMyAvatar(baseUser.id, VALID_JPEG_BUFFER),
      (err: unknown) =>
        err instanceof ApiError && err.statusCode === 403 && err.code === 'ACCOUNT_LOCKED',
    );

    assert.equal(updateCalled, false);
    assert.deepEqual(deletedPublicIds, ['rentmate/avatars/toctou-public-id']);
  });

  test('rollback path logs console.warn when mediaService.deleteResource returns false', async () => {
    const warnings: string[] = [];
    stub(console, 'warn', (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    });

    stub(prisma.user, 'findUnique', async () => ({
      id: baseUser.id,
      accountStatus: 'ACTIVE',
      avatarCloudinaryPublicId: null,
    }));

    stub(mediaService, 'uploadStream', async () => ({
      secureUrl: 'https://res.cloudinary.com/demo/image/upload/v2/rentmate/avatars/new.webp',
      publicId: 'rentmate/avatars/rollback-false-id',
    }));

    stub(prisma, '$transaction', async () => {
      throw new Error('DB failure');
    });

    stub(mediaService, 'deleteResource', async () => false);

    await assert.rejects(
      () => uploadMyAvatar(baseUser.id, VALID_JPEG_BUFFER),
      { message: 'DB failure' },
    );

    assert.equal(
      warnings.some((msg) => msg.includes('rentmate/avatars/rollback-false-id')),
      true,
    );
  });

  test('concurrent 2-upload serialization yields distinct publicIds and 2nd call deletes 1st call publicId so zero intermediate images are orphaned', async () => {
    const dbState = {
      accountStatus: 'ACTIVE',
      avatarCloudinaryPublicId: 'rentmate/avatars/initial-id' as string | null,
      avatarUrl: 'https://res.cloudinary.com/demo/image/upload/v1/initial.webp' as string | null,
    };
    const uploadedPublicIds: string[] = [];
    const deletedPublicIds: string[] = [];
    let txLock: Promise<void> = Promise.resolve();

    stub(prisma.user, 'findUnique', async () => ({
      id: baseUser.id,
      accountStatus: dbState.accountStatus,
      avatarCloudinaryPublicId: dbState.avatarCloudinaryPublicId,
    }));

    stub(mediaService, 'uploadStream', async (_buffer: Buffer, options: any) => {
      uploadedPublicIds.push(options.publicId);
      // Stagger upload completion slightly while keeping publicId generation within ~0-1ms
      await new Promise((resolve) => setTimeout(resolve, uploadedPublicIds.length === 1 ? 15 : 5));
      return {
        secureUrl: `https://res.cloudinary.com/demo/image/upload/v2/${options.publicId}.webp`,
        publicId: options.publicId,
      };
    });

    stub(prisma, '$transaction', async (callback: any) => {
      const previousLock = txLock;
      let releaseLock!: () => void;
      txLock = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });

      await previousLock;
      try {
        const txClient = {
          $queryRaw: async () => [
            {
              id: baseUser.id,
              account_status: dbState.accountStatus,
              avatar_cloudinary_public_id: dbState.avatarCloudinaryPublicId,
            },
          ],
          user: {
            update: async (args: any) => {
              dbState.avatarUrl = args.data.avatarUrl;
              dbState.avatarCloudinaryPublicId = args.data.avatarCloudinaryPublicId;
              return {
                id: baseUser.id,
                fullName: baseUser.fullName,
                email: baseUser.email,
                phone: baseUser.phone,
                role: baseUser.role,
                accountStatus: dbState.accountStatus,
                avatarUrl: dbState.avatarUrl,
                dateOfBirth: baseUser.dateOfBirth,
                address: baseUser.address,
              };
            },
          },
        };
        return await callback(txClient);
      } finally {
        releaseLock();
      }
    });

    stub(mediaService, 'deleteResource', async (publicId: string) => {
      deletedPublicIds.push(publicId);
      return true;
    });

    const [res1, res2] = await Promise.all([
      uploadMyAvatar(baseUser.id, VALID_JPEG_BUFFER),
      uploadMyAvatar(baseUser.id, VALID_PNG_BUFFER),
    ]);

    assert.equal(uploadedPublicIds.length, 2);
    assert.notEqual(uploadedPublicIds[0], uploadedPublicIds[1]);
    assert.ok(res1.avatarUrl);
    assert.ok(res2.avatarUrl);

    // Because upload #2 finishes uploadStream faster (5ms vs 15ms), it enters tx first and deletes initial-id;
    // upload #1 then acquires the row lock, sees upload #2's publicId as previousPublicId, and deletes it!
    // Regardless of which finishes first, exactly initial-id + the losing upload are deleted, and only the winner remains in DB.
    const finalPublicId = dbState.avatarCloudinaryPublicId!;
    const losingPublicId = uploadedPublicIds.find((id) => id !== finalPublicId)!;
    assert.ok(losingPublicId);
    assert.equal(deletedPublicIds.includes('rentmate/avatars/initial-id'), true);
    assert.equal(deletedPublicIds.includes(losingPublicId), true);
    assert.equal(deletedPublicIds.includes(finalPublicId), false);
    assert.equal(deletedPublicIds.length, 2);
  });

  test('best-effort old avatar deletion failure or throw does not fail uploadMyAvatar', async () => {
    stub(prisma.user, 'findUnique', async () => ({
      id: baseUser.id,
      accountStatus: 'ACTIVE',
      avatarCloudinaryPublicId: baseUser.avatarCloudinaryPublicId,
    }));

    stub(mediaService, 'uploadStream', async () => ({
      secureUrl: 'https://res.cloudinary.com/demo/image/upload/v2/rentmate/avatars/new.webp',
      publicId: 'rentmate/avatars/new-public-id',
    }));

    const txClient = {
      $queryRaw: async () => [
        {
          id: baseUser.id,
          account_status: 'ACTIVE',
          avatar_cloudinary_public_id: baseUser.avatarCloudinaryPublicId,
        },
      ],
      user: {
        update: async (args: any) => ({
          id: baseUser.id,
          fullName: baseUser.fullName,
          email: baseUser.email,
          phone: baseUser.phone,
          role: baseUser.role,
          accountStatus: baseUser.accountStatus,
          avatarUrl: args.data.avatarUrl,
          dateOfBirth: baseUser.dateOfBirth,
          address: baseUser.address,
        }),
      },
    };
    stub(prisma, '$transaction', async (callback: any) => callback(txClient));

    stub(mediaService, 'deleteResource', async () => {
      throw new Error('Cloudinary cleanup failed');
    });

    const result = await uploadMyAvatar(baseUser.id, VALID_JPEG_BUFFER);
    assert.equal(
      result.avatarUrl,
      'https://res.cloudinary.com/demo/image/upload/v2/rentmate/avatars/new.webp',
    );
  });
});

describe('HTTP POST /api/v1/users/me/avatar', () => {
  test('returns 401 UNAUTHORIZED when no token is provided', async () => {
    const { response, body } = await request('/api/v1/users/me/avatar', {
      method: 'POST',
    });

    assert.equal(response.status, 401);
    assert.equal(body.code, 'UNAUTHORIZED');
  });

  test('returns 403 ACCOUNT_LOCKED when user is locked or inactive', async () => {
    for (const status of ['LOCKED', 'INACTIVE']) {
      stub(prisma.user, 'findUnique', async () => ({
        ...baseUser,
        accountStatus: status,
      }));

      const formData = new FormData();
      formData.append('avatar', new Blob([VALID_JPEG_BUFFER], { type: 'image/jpeg' }), 'avatar.jpg');

      const { response, body } = await request('/api/v1/users/me/avatar', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
        },
        body: formData,
      });

      assert.equal(response.status, 403);
      assert.equal(body.code, 'ACCOUNT_LOCKED');
    }
  });

  test('returns 400 FILE_REQUIRED when no file is attached', async () => {
    stub(prisma.user, 'findUnique', async () => baseUser);

    const formData = new FormData();
    const { response, body } = await request('/api/v1/users/me/avatar', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
      },
      body: formData,
    });

    assert.equal(response.status, 400);
    assert.equal(body.code, 'FILE_REQUIRED');
  });

  test("returns 400 INVALID_FILE_UPLOAD when file is sent under wrong multipart field name 'file'", async () => {
    stub(prisma.user, 'findUnique', async () => baseUser);

    const formData = new FormData();
    formData.append('file', new Blob([VALID_JPEG_BUFFER], { type: 'image/jpeg' }), 'avatar.jpg');

    const { response, body } = await request('/api/v1/users/me/avatar', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
      },
      body: formData,
    });

    assert.equal(response.status, 400);
    assert.equal(body.code, 'INVALID_FILE_UPLOAD');
  });

  test('returns 413 FILE_TOO_LARGE when file exceeds 5MB', async () => {
    stub(prisma.user, 'findUnique', async () => baseUser);

    const oversizedBuffer = Buffer.alloc(5 * 1024 * 1024 + 1, 0x00);
    VALID_JPEG_BUFFER.copy(oversizedBuffer, 0);

    const formData = new FormData();
    formData.append('avatar', new Blob([oversizedBuffer], { type: 'image/jpeg' }), 'large.jpg');

    const { response, body } = await request('/api/v1/users/me/avatar', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
      },
      body: formData,
    });

    assert.equal(response.status, 413);
    assert.equal(body.code, 'FILE_TOO_LARGE');
  });

  test('returns 415 UNSUPPORTED_MEDIA_TYPE for 0-byte file with image/jpeg MIME', async () => {
    stub(prisma.user, 'findUnique', async () => baseUser);

    const formData = new FormData();
    formData.append('avatar', new Blob([Buffer.alloc(0)], { type: 'image/jpeg' }), 'empty.jpg');

    const { response, body } = await request('/api/v1/users/me/avatar', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
      },
      body: formData,
    });

    assert.equal(response.status, 415);
    assert.equal(body.code, 'UNSUPPORTED_MEDIA_TYPE');
  });

  test('returns 415 UNSUPPORTED_MEDIA_TYPE for unsupported MIME type or spoofed magic bytes', async () => {
    stub(prisma.user, 'findUnique', async () => baseUser);

    // Unsupported MIME type
    const badMimeForm = new FormData();
    badMimeForm.append('avatar', new Blob([VALID_JPEG_BUFFER], { type: 'image/gif' }), 'avatar.gif');
    const badMimeRes = await request('/api/v1/users/me/avatar', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
      },
      body: badMimeForm,
    });
    assert.equal(badMimeRes.response.status, 415);
    assert.equal(badMimeRes.body.code, 'UNSUPPORTED_MEDIA_TYPE');

    // Spoofed magic bytes (text payload with image/jpeg MIME)
    const spoofedForm = new FormData();
    spoofedForm.append(
      'avatar',
      new Blob([Buffer.from('not-a-real-jpeg')], { type: 'image/jpeg' }),
      'fake.jpg',
    );
    const spoofedRes = await request('/api/v1/users/me/avatar', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
      },
      body: spoofedForm,
    });
    assert.equal(spoofedRes.response.status, 415);
    assert.equal(spoofedRes.body.code, 'UNSUPPORTED_MEDIA_TYPE');

    // Mismatched MIME and magic bytes (PNG bytes declared as image/jpeg)
    const mismatchForm = new FormData();
    mismatchForm.append(
      'avatar',
      new Blob([VALID_PNG_BUFFER], { type: 'image/jpeg' }),
      'png-as-jpg.jpg',
    );
    const mismatchRes = await request('/api/v1/users/me/avatar', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
      },
      body: mismatchForm,
    });
    assert.equal(mismatchRes.response.status, 415);
    assert.equal(mismatchRes.body.code, 'UNSUPPORTED_MEDIA_TYPE');
  });

  test('returns 500 when mediaService.uploadStream rejects and never calls DB transaction or update', async () => {
    let txCalled = false;

    stub(prisma.user, 'findUnique', async () => ({
      id: baseUser.id,
      role: baseUser.role,
      accountStatus: baseUser.accountStatus,
      fullName: baseUser.fullName,
      avatarCloudinaryPublicId: baseUser.avatarCloudinaryPublicId,
    }));

    stub(mediaService, 'uploadStream', async () => {
      throw new Error('Cloudinary upload failed');
    });

    stub(prisma, '$transaction', async () => {
      txCalled = true;
    });

    const formData = new FormData();
    formData.append('avatar', new Blob([VALID_JPEG_BUFFER], { type: 'image/jpeg' }), 'avatar.jpg');

    const { response } = await request('/api/v1/users/me/avatar', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
      },
      body: formData,
    });

    assert.equal(response.status, 500);
    assert.equal(txCalled, false);
  });

  test('returns 200 OK with full UserProfileDTO, passes 512x512 face transformation, updates DB safely, and deletes old avatar', async () => {
    let capturedUploadOptions: any;
    let capturedUpdateArgs: any;
    const deletedPublicIds: string[] = [];

    stub(prisma.user, 'findUnique', async () => ({
      id: baseUser.id,
      role: baseUser.role,
      accountStatus: baseUser.accountStatus,
      fullName: baseUser.fullName,
      avatarCloudinaryPublicId: baseUser.avatarCloudinaryPublicId,
    }));

    stub(mediaService, 'uploadStream', async (_buffer: Buffer, options: any) => {
      capturedUploadOptions = options;
      return {
        secureUrl: 'https://res.cloudinary.com/demo/image/upload/v2/rentmate/avatars/new.webp',
        publicId: options.publicId,
      };
    });

    const txClient = {
      $queryRaw: async () => [
        {
          id: baseUser.id,
          account_status: baseUser.accountStatus,
          avatar_cloudinary_public_id: baseUser.avatarCloudinaryPublicId,
        },
      ],
      user: {
        update: async (args: any) => {
          capturedUpdateArgs = args;
          assert.equal('passwordHash' in args.select, false);
          assert.equal('avatarCloudinaryPublicId' in args.select, false);
          return {
            id: baseUser.id,
            fullName: baseUser.fullName,
            email: baseUser.email,
            phone: baseUser.phone,
            role: baseUser.role,
            accountStatus: baseUser.accountStatus,
            avatarUrl: args.data.avatarUrl,
            dateOfBirth: baseUser.dateOfBirth,
            address: baseUser.address,
          };
        },
      },
    };
    stub(prisma, '$transaction', async (callback: any) => callback(txClient));

    stub(mediaService, 'deleteResource', async (publicId: string) => {
      deletedPublicIds.push(publicId);
      return true;
    });

    const formData = new FormData();
    formData.append('avatar', new Blob([VALID_WEBP_BUFFER], { type: 'image/webp' }), 'avatar.webp');

    const { response, body } = await request('/api/v1/users/me/avatar', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
      },
      body: formData,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(capturedUploadOptions.transformation, {
      width: 512,
      height: 512,
      crop: 'fill',
      gravity: 'face',
    });
    assert.equal(
      capturedUpdateArgs.data.avatarUrl,
      'https://res.cloudinary.com/demo/image/upload/v2/rentmate/avatars/new.webp',
    );
    assert.equal(capturedUpdateArgs.data.avatarCloudinaryPublicId, capturedUploadOptions.publicId);
    assert.deepEqual(deletedPublicIds, [baseUser.avatarCloudinaryPublicId]);
    assert.deepEqual(body, {
      userId: baseUser.id,
      fullName: baseUser.fullName,
      email: baseUser.email,
      phone: baseUser.phone,
      role: baseUser.role,
      status: baseUser.accountStatus,
      avatarUrl: 'https://res.cloudinary.com/demo/image/upload/v2/rentmate/avatars/new.webp',
      dateOfBirth: '2000-05-15',
      address: baseUser.address,
    });
    assert.equal('avatarCloudinaryPublicId' in body, false);
    assert.equal('passwordHash' in body, false);
  });

  test('returns 500 and deletes newly uploaded asset if DB update fails over HTTP', async () => {
    const deletedPublicIds: string[] = [];

    stub(prisma.user, 'findUnique', async () => ({
      id: baseUser.id,
      role: baseUser.role,
      accountStatus: baseUser.accountStatus,
      fullName: baseUser.fullName,
      avatarCloudinaryPublicId: baseUser.avatarCloudinaryPublicId,
    }));

    stub(mediaService, 'uploadStream', async () => ({
      secureUrl: 'https://res.cloudinary.com/demo/image/upload/v2/rentmate/avatars/new.webp',
      publicId: 'rentmate/avatars/rollback-id',
    }));

    const txClient = {
      $queryRaw: async () => [
        {
          id: baseUser.id,
          account_status: baseUser.accountStatus,
          avatar_cloudinary_public_id: baseUser.avatarCloudinaryPublicId,
        },
      ],
      user: {
        update: async () => {
          throw new Error('Database error');
        },
      },
    };
    stub(prisma, '$transaction', async (callback: any) => callback(txClient));

    stub(mediaService, 'deleteResource', async (publicId: string) => {
      deletedPublicIds.push(publicId);
      return true;
    });

    const formData = new FormData();
    formData.append('avatar', new Blob([VALID_JPEG_BUFFER], { type: 'image/jpeg' }), 'avatar.jpg');

    const { response } = await request('/api/v1/users/me/avatar', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
      },
      body: formData,
    });

    assert.equal(response.status, 500);
    assert.deepEqual(deletedPublicIds, ['rentmate/avatars/rollback-id']);
  });

  test('returns 200 OK even when best-effort old avatar deletion returns false', async () => {
    stub(prisma.user, 'findUnique', async () => ({
      id: baseUser.id,
      role: baseUser.role,
      accountStatus: baseUser.accountStatus,
      fullName: baseUser.fullName,
      avatarCloudinaryPublicId: baseUser.avatarCloudinaryPublicId,
    }));

    stub(mediaService, 'uploadStream', async () => ({
      secureUrl: 'https://res.cloudinary.com/demo/image/upload/v2/rentmate/avatars/new.webp',
      publicId: 'rentmate/avatars/new-id',
    }));

    const txClient = {
      $queryRaw: async () => [
        {
          id: baseUser.id,
          account_status: baseUser.accountStatus,
          avatar_cloudinary_public_id: baseUser.avatarCloudinaryPublicId,
        },
      ],
      user: {
        update: async (args: any) => ({
          id: baseUser.id,
          fullName: baseUser.fullName,
          email: baseUser.email,
          phone: baseUser.phone,
          role: baseUser.role,
          accountStatus: baseUser.accountStatus,
          avatarUrl: args.data.avatarUrl,
          dateOfBirth: baseUser.dateOfBirth,
          address: baseUser.address,
        }),
      },
    };
    stub(prisma, '$transaction', async (callback: any) => callback(txClient));

    stub(mediaService, 'deleteResource', async () => false);

    const formData = new FormData();
    formData.append('avatar', new Blob([VALID_JPEG_BUFFER], { type: 'image/jpeg' }), 'avatar.jpg');

    const { response, body } = await request('/api/v1/users/me/avatar', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
      },
      body: formData,
    });

    assert.equal(response.status, 200);
    assert.equal(
      body.avatarUrl,
      'https://res.cloudinary.com/demo/image/upload/v2/rentmate/avatars/new.webp',
    );
  });
});
