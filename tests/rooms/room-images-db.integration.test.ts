import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, test } from 'node:test';
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

test('Live DB: concurrent room image batch uploads strictly enforce max 10 images limit and compensate orphaned Cloudinary uploads', async (t) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    t.skip('PostgreSQL is not available');
    return;
  }

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  let landlordId: string | undefined;
  let propertyId: string | undefined;
  let roomId: string | undefined;

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const landlord = await prisma.user.create({
      data: {
        fullName: 'Media Race Landlord',
        email: `media-race-owner-${suffix}@rentmate.test`,
        phone: `09${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`,
        passwordHash: 'test-only',
        role: 'LANDLORD',
        accountStatus: 'ACTIVE',
      },
    });
    landlordId = landlord.id;

    const property = await prisma.property.create({
      data: {
        landlordId,
        name: `Media Race Property ${suffix}`,
        address: 'Test address',
        status: 'ACTIVE',
      },
    });
    propertyId = property.id;

    const room = await prisma.room.create({
      data: {
        propertyId,
        roomCode: `IMG-RACE-${suffix}`,
        areaM2: 24,
        maxOccupants: 2,
        monthlyRent: 3000000,
        depositRequired: 3000000,
        electricityRate: 3500,
        waterRate: 20000,
        occupancyStatus: 'VACANT',
        visibilityStatus: 'VISIBLE',
      },
    });
    roomId = room.id;

    // Tạo sẵn 9 ảnh cho phòng -> chỉ còn đúng 1 slot trống
    await prisma.roomImage.createMany({
      data: Array.from({ length: 9 }, (_, idx) => ({
        roomId: room.id,
        imageUrl: `https://res.cloudinary.com/test/image/upload/v1/rentmate/rooms/${room.id}/existing-${idx}.webp`,
        sortOrder: idx,
      })),
    });

    const uploadedPublicIds: string[] = [];
    const compensatedPublicIds: string[] = [];

    // Barrier đảm bảo cả 2 batch đồng thời vượt qua bước pre-check (đều đọc initialCount = 9)
    // và bước vào createRoomImageWithinLimit cùng một lúc để ép race condition thật trên PostgreSQL
    let enteredFirstUpload = 0;
    let releaseBarrier!: () => void;
    const bothBatchesInUpload = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    stub(mediaService, 'uploadStream', async (_buf: Buffer, opts: { publicId: string }) => {
      uploadedPublicIds.push(opts.publicId);
      enteredFirstUpload++;
      if (enteredFirstUpload === 2) {
        releaseBarrier();
      }
      if (enteredFirstUpload <= 2) {
        await bothBatchesInUpload;
      }
      return {
        secureUrl: `https://res.cloudinary.com/test/image/upload/v1/${opts.publicId}.webp`,
        publicId: opts.publicId,
      };
    });

    stub(mediaService, 'deleteResource', async (publicId: string) => {
      compensatedPublicIds.push(publicId);
      return true;
    });

    const port = (server.address() as AddressInfo).port;
    const token = signAccessToken(landlordId);

    const buildForm = (batchIdx: number) => {
      const formData = new FormData();
      const validJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      formData.append('images', new Blob([validJpeg], { type: 'image/jpeg' }), `b${batchIdx}-1.jpg`);
      formData.append('images', new Blob([validJpeg], { type: 'image/jpeg' }), `b${batchIdx}-2.jpg`);
      return formData;
    };

    const responses = await Promise.all([1, 2].map((batchIdx) =>
      fetch(`http://127.0.0.1:${port}/api/v1/landlord/rooms/${roomId}/images`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: buildForm(batchIdx),
      }),
    ));

    const results = await Promise.all(
      responses.map(async (res) => ({
        status: res.status,
        body: (await res.json()) as {
          code?: string;
          summary?: { succeeded: number; failed: number; remainingSlots: number };
          uploaded?: Array<{ publicId: string }>;
          failed?: Array<{ code: string }>;
        },
      })),
    );

    const totalSucceeded = results.reduce((sum, r) => sum + (r.body.summary?.succeeded ?? 0), 0);
    assert.equal(totalSucceeded, 1, `Expected strictly 1 succeeded across both concurrent batches, got ${JSON.stringify(results)}`);

    // Tổng số ảnh trong DB tuyệt đối <= 10 (cụ thể là đúng 10)
    const finalDbCount = await prisma.roomImage.count({ where: { roomId } });
    assert.equal(finalDbCount, 10);

    // Mọi ảnh thừa đã đẩy lên Cloudinary phải được xóa bù qua deleteResource
    const persistedPublicIds = new Set(results.flatMap((r) => (r.body.uploaded ?? []).map((u) => u.publicId)));
    assert.equal(persistedPublicIds.size, 1);
    const expectedCompensated = uploadedPublicIds.filter((id) => !persistedPublicIds.has(id));
    assert.ok(expectedCompensated.length >= 1, 'Expected at least 1 orphaned Cloudinary upload to be compensated');
    assert.deepEqual(compensatedPublicIds.sort(), expectedCompensated.sort());

    // Mọi thất bại phải báo đúng mã ROOM_IMAGE_LIMIT_EXCEEDED
    for (const r of results) {
      if (r.body.failed) {
        assert.ok(r.body.failed.every((f) => f.code === 'ROOM_IMAGE_LIMIT_EXCEEDED'));
      } else if (r.status === 400) {
        assert.equal(r.body.code, 'ROOM_IMAGE_LIMIT_EXCEEDED');
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    if (roomId) {
      await prisma.roomImage.deleteMany({ where: { roomId } }).catch(() => {});
      await prisma.room.delete({ where: { id: roomId } }).catch(() => {});
    }
    if (propertyId) {
      await prisma.property.delete({ where: { id: propertyId } }).catch(() => {});
    }
    if (landlordId) {
      await prisma.user.delete({ where: { id: landlordId } }).catch(() => {});
    }
  }
});
