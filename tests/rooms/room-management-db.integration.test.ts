import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { app } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { signAccessToken } from '../../src/modules/auth/auth.security';

process.env.JWT_SECRET = 'test-secret-must-have-at-least-thirty-two-bytes';

async function checkPostgresAvailable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

test('Live DB: concurrent room creations with case-insensitive duplicate roomCode allow only one and return 409 DUPLICATE_ROOM_CODE', async (t) => {
  if (!(await checkPostgresAvailable())) {
    t.skip('PostgreSQL is not available');
    return;
  }

  const indexRows = await prisma.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'rooms'
      AND indexname = 'uq_rooms_property_room_code_lower'
  `;
  if (indexRows.length === 0) {
    t.skip('Room code unique index migration (uq_rooms_property_room_code_lower) is not applied');
    return;
  }

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  let landlordId: string | undefined;
  let propertyId: string | undefined;
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const landlord = await prisma.user.create({
      data: {
        fullName: 'Room Race Landlord',
        email: `room-race-owner-${suffix}@rentmate.test`,
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
        name: `Room Race Property ${suffix}`,
        address: 'Test address',
        status: 'ACTIVE',
      },
    });
    propertyId = property.id;

    const port = (server.address() as AddressInfo).port;
    const token = signAccessToken(landlordId);

    const payloads = ['P.301-RACE', 'p.301-race'].map((roomCode) => ({
      roomCode,
      floor: 3,
      areaM2: 25,
      maxOccupants: 2,
      monthlyRent: 3500000,
      depositRequired: 3500000,
      electricityRate: 3500,
      waterRate: 20000,
    }));

    const responses = await Promise.all(
      payloads.map((payload) =>
        fetch(`http://127.0.0.1:${port}/api/v1/landlord/properties/${propertyId}/rooms`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        }),
      ),
    );

    const results = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      })),
    );

    assert.deepEqual(
      results.map((r) => r.status).sort(),
      [201, 409],
      `Expected [201, 409], got ${JSON.stringify(results)}`,
    );
    assert.equal(
      results.find((r) => r.status === 409)?.body.code,
      'DUPLICATE_ROOM_CODE',
    );

    const roomsCount = await prisma.room.count({ where: { propertyId } });
    assert.equal(roomsCount, 1);

    // Kiểm tra trực tiếp tầng Repository Transaction (bỏ qua Service pre-check) khi tạo trùng khác hoa/thường đồng thời
    const { RoomManagementRepository } = await import('../../src/modules/rooms/room-management.repository');
    const { ApiError } = await import('../../src/common/errors/api-error');
    const txSettled = await Promise.allSettled(
      ['P.302-TX', 'p.302-tx'].map((code) =>
        RoomManagementRepository.createRoomTransaction(propertyId!, {
          roomCode: code,
          areaM2: 20,
          maxOccupants: 2,
          monthlyRent: 2500000,
          depositRequired: 2500000,
          electricityRate: 3500,
          waterRate: 20000,
        }),
      ),
    );

    const fulfilled = txSettled.filter((r) => r.status === 'fulfilled');
    const rejected = txSettled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof ApiError);
    assert.equal(rejected[0].reason.statusCode, 409);
    assert.equal(rejected[0].reason.code, 'DUPLICATE_ROOM_CODE');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    if (propertyId) {
      await prisma.room.deleteMany({ where: { propertyId } }).catch(() => {});
      await prisma.property.delete({ where: { id: propertyId } }).catch(() => {});
    }
    if (landlordId) {
      await prisma.user.delete({ where: { id: landlordId } }).catch(() => {});
    }
  }
});

test('Live DB: concurrent transition to MAINTENANCE and createRentalRequest never leaves a MAINTENANCE room with a PENDING request', async (t) => {
  if (!(await checkPostgresAvailable())) {
    t.skip('PostgreSQL is not available');
    return;
  }

  const columnRows = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'rental_requests'
      AND column_name IN ('duration_months', 'message', 'rejection_reason')
  `;
  if (columnRows.length < 3) {
    t.skip('Rental request migration is not applied');
    return;
  }

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const userIds: string[] = [];
  let propertyId: string | undefined;
  const roomIds: string[] = [];
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const landlord = await prisma.user.create({
      data: {
        fullName: 'Maint Race Landlord',
        email: `maint-race-owner-${suffix}@rentmate.test`,
        phone: `09${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`,
        passwordHash: 'test-only',
        role: 'LANDLORD',
        accountStatus: 'ACTIVE',
      },
    });
    userIds.push(landlord.id);

    const tenant = await prisma.user.create({
      data: {
        fullName: 'Maint Race Tenant',
        email: `maint-race-tenant-${suffix}@rentmate.test`,
        phone: `09${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`,
        passwordHash: 'test-only',
        role: 'TENANT',
        accountStatus: 'ACTIVE',
      },
    });
    userIds.push(tenant.id);

    const property = await prisma.property.create({
      data: {
        landlordId: landlord.id,
        name: `Maint Race Property ${suffix}`,
        address: 'Test address',
        status: 'ACTIVE',
      },
    });
    propertyId = property.id;

    const port = (server.address() as AddressInfo).port;
    const landlordToken = signAccessToken(landlord.id);
    const tenantToken = signAccessToken(tenant.id);

    // Chạy 3 vòng race để kiểm chứng cả khi bên nào thắng trước, invariant vẫn tuyệt đối được bảo toàn
    for (let round = 0; round < 3; round++) {
      const room = await prisma.room.create({
        data: {
          propertyId,
          roomCode: `MR-${round}-${suffix}`,
          areaM2: 22,
          maxOccupants: 2,
          monthlyRent: 2500000,
          depositRequired: 2500000,
          electricityRate: 3500,
          waterRate: 20000,
          occupancyStatus: 'VACANT',
          visibilityStatus: 'VISIBLE',
        },
      });
      roomIds.push(room.id);

      const [maintRes, rentalRes] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/api/v1/landlord/rooms/${room.id}/operational-status`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${landlordToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ occupancyStatus: 'MAINTENANCE' }),
        }),
        fetch(`http://127.0.0.1:${port}/api/v1/rental-requests`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tenantToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            roomId: room.id,
            desiredMoveInDate: '2027-12-01',
            durationMonths: 12,
          }),
        }),
      ]);

      const maintBody = (await maintRes.json()) as Record<string, unknown>;
      const rentalBody = (await rentalRes.json()) as Record<string, unknown>;

      // Không thể cả 2 đều thành công
      assert.ok(
        !(maintRes.status === 200 && rentalRes.status === 201),
        `Both succeeded in round ${round}: maint=${maintRes.status}, rental=${rentalRes.status}`,
      );

      const dbRoom = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
      const pendingCount = await prisma.rentalRequest.count({
        where: { roomId: room.id, status: 'PENDING' },
      });

      // Invariant cốt lõi: Phòng MAINTENANCE không bao giờ được có RentalRequest PENDING
      assert.ok(
        !(dbRoom.occupancyStatus === 'MAINTENANCE' && pendingCount > 0),
        `Invariant violated in round ${round}: room is MAINTENANCE with ${pendingCount} PENDING requests`,
      );

      if (maintRes.status === 200) {
        assert.equal(dbRoom.occupancyStatus, 'MAINTENANCE');
        assert.equal(dbRoom.visibilityStatus, 'HIDDEN');
        assert.equal(pendingCount, 0);
        assert.ok([404, 409].includes(rentalRes.status), `Unexpected rental status: ${rentalRes.status} (${JSON.stringify(rentalBody)})`);
      } else if (rentalRes.status === 201) {
        assert.equal(dbRoom.occupancyStatus, 'VACANT');
        assert.equal(pendingCount, 1);
        assert.equal(maintRes.status, 409);
        assert.equal(maintBody.code, 'CANNOT_MAINTAIN_ACTIVE_ROOM');
      } else {
        assert.fail(`Unexpected outcome: maint=${maintRes.status}, rental=${rentalRes.status}`);
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    if (roomIds.length) {
      await prisma.rentalRequest.deleteMany({ where: { roomId: { in: roomIds } } }).catch(() => {});
      await prisma.room.deleteMany({ where: { id: { in: roomIds } } }).catch(() => {});
    }
    if (propertyId) {
      await prisma.property.delete({ where: { id: propertyId } }).catch(() => {});
    }
    if (userIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    }
  }
});
