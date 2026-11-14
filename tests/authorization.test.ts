import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { afterEach, describe, test } from 'node:test';
import express, { type Request, type Response } from 'express';
import { errorHandler } from '../src/common/middleware/error-handler';
import { requireAuth } from '../src/common/require-auth';
import { requireRole, requireActiveUser } from '../src/common/middleware/require-role';
import {
  assertLandlordProperty,
  assertLandlordRoom,
  assertScopedAppointment,
  assertScopedRentalRequest,
  OWNERSHIP_ERRORS,
} from '../src/common/ownership';
import { prisma } from '../src/infrastructure/database/prisma';
import { signAccessToken } from '../src/modules/auth/auth.security';

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

// Minimum test accounts: 2 landlords, 2 tenants, 1 inactive user, 1 admin
const landlord1 = {
  id: '11111111-1111-4111-a111-111111111111',
  fullName: 'Chu Tro 1',
  role: 'LANDLORD',
  accountStatus: 'ACTIVE',
};

const landlord2 = {
  id: '22222222-2222-4222-a222-222222222222',
  fullName: 'Chu Tro 2',
  role: 'LANDLORD',
  accountStatus: 'ACTIVE',
};

const tenant1 = {
  id: '33333333-3333-4333-a333-333333333333',
  fullName: 'Nguoi Thue 1',
  role: 'TENANT',
  accountStatus: 'ACTIVE',
};

const tenant2 = {
  id: '44444444-4444-4444-a444-444444444444',
  fullName: 'Nguoi Thue 2',
  role: 'TENANT',
  accountStatus: 'ACTIVE',
};

const inactiveUser = {
  id: '55555555-5555-4555-a555-555555555555',
  fullName: 'Tai Khoan Khoa',
  role: 'LANDLORD',
  accountStatus: 'LOCKED',
};

const adminUser = {
  id: '66666666-6666-4666-a666-666666666666',
  fullName: 'Quan Tri Vien',
  role: 'ADMIN',
  accountStatus: 'ACTIVE',
};

const allUsers: Record<string, typeof landlord1> = {
  [landlord1.id]: landlord1,
  [landlord2.id]: landlord2,
  [tenant1.id]: tenant1,
  [tenant2.id]: tenant2,
  [inactiveUser.id]: inactiveUser,
  [adminUser.id]: adminUser,
};

// Test app with protected routes for landlords, tenants, active users, and ownership checks
function createTestApp() {
  const app = express();
  app.use(express.json());

  // Landlord-only route
  app.get(
    '/api/v1/landlord/properties',
    requireAuth,
    requireRole('LANDLORD'),
    (req: Request, res: Response) => {
      res.status(200).json({
        success: true,
        currentUser: res.locals.currentUser,
      });
    },
  );

  // Tenant-only route
  app.get(
    '/api/v1/tenant/contracts',
    requireAuth,
    requireRole('TENANT'),
    (req: Request, res: Response) => {
      res.status(200).json({
        success: true,
        currentUser: res.locals.currentUser,
      });
    },
  );

  // Multi-role route (Landlord or Admin)
  app.get(
    '/api/v1/manage/buildings',
    requireAuth,
    requireRole('LANDLORD', 'ADMIN'),
    (req: Request, res: Response) => {
      res.status(200).json({
        success: true,
        currentUser: res.locals.currentUser,
      });
    },
  );

  // Active user route (any role)
  app.get(
    '/api/v1/profile/active',
    requireAuth,
    requireActiveUser,
    (req: Request, res: Response) => {
      res.status(200).json({
        success: true,
        currentUser: res.locals.currentUser,
      });
    },
  );

  // Scoped Property Ownership endpoint
  app.get(
    '/api/v1/landlord/properties/:propertyId',
    requireAuth,
    requireRole('LANDLORD', 'ADMIN'),
    async (req: Request, res: Response, next) => {
      try {
        const property = await assertLandlordProperty(
          req.params.propertyId,
          res.locals.currentUser!.id,
        );
        res.status(200).json({ success: true, property });
      } catch (err) {
        next(err);
      }
    },
  );

  // Scoped Room Ownership endpoint
  app.get(
    '/api/v1/landlord/rooms/:roomId',
    requireAuth,
    requireRole('LANDLORD', 'ADMIN'),
    async (req: Request, res: Response, next) => {
      try {
        const room = await assertLandlordRoom(
          req.params.roomId,
          res.locals.currentUser!.id,
        );
        res.status(200).json({ success: true, room });
      } catch (err) {
        next(err);
      }
    },
  );

  // Scoped Viewing Appointment endpoint (#18)
  app.get(
    '/api/v1/appointments/:appointmentId',
    requireAuth,
    requireRole('TENANT', 'LANDLORD', 'ADMIN'),
    async (req: Request, res: Response, next) => {
      try {
        const appointment = await assertScopedAppointment(
          req.params.appointmentId,
          res.locals.currentUser!,
        );
        res.status(200).json({ success: true, appointment });
      } catch (err) {
        next(err);
      }
    },
  );

  // Scoped Rental Request endpoint (#19)
  app.get(
    '/api/v1/rental-requests/:requestId',
    requireAuth,
    requireRole('TENANT', 'LANDLORD', 'ADMIN'),
    async (req: Request, res: Response, next) => {
      try {
        const rentalRequest = await assertScopedRentalRequest(
          req.params.requestId,
          res.locals.currentUser!,
        );
        res.status(200).json({ success: true, rentalRequest });
      } catch (err) {
        next(err);
      }
    },
  );

  app.use(errorHandler);
  return app;
}

async function requestApp(app: express.Express, path: string, init: RequestInit = {}) {
  const server = app.listen(0);
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const text = await response.text();
    const body = response.headers.get('content-type')?.includes('application/json')
      ? JSON.parse(text)
      : {};
    return { response, body };
  } finally {
    server.close();
  }
}

describe('Authorization & Role Checking (requireRole & requireActiveUser)', () => {
  const app = createTestApp();

  test('valid JWT but missing DB user returns 401 UNAUTHORIZED with exact message', async () => {
    stub(prisma.user, 'findUnique', async () => null);
    const nonExistentUserId = '99999999-9999-4999-a999-999999999999';

    const { response, body } = await requestApp(app, '/api/v1/landlord/properties', {
      headers: { Authorization: `Bearer ${signAccessToken(nonExistentUserId)}` },
    });

    assert.equal(response.status, 401);
    assert.equal(body.success, false);
    assert.equal(body.code, 'UNAUTHORIZED');
    assert.equal(body.message, 'Tài khoản không tồn tại hoặc phiên đăng nhập không hợp lệ');
    assert.ok(body.traceId);
  });

  test('existing user with accountStatus !== ACTIVE returns 403 ACCOUNT_LOCKED with exact message', async () => {
    stub(prisma.user, 'findUnique', async () => inactiveUser);

    const { response, body } = await requestApp(app, '/api/v1/landlord/properties', {
      headers: { Authorization: `Bearer ${signAccessToken(inactiveUser.id)}` },
    });

    assert.equal(response.status, 403);
    assert.equal(body.success, false);
    assert.equal(body.code, 'ACCOUNT_LOCKED');
    assert.equal(body.message, 'Tài khoản đã bị khóa hoặc chưa kích hoạt');
    assert.ok(body.traceId);
  });

  test('role not in allowedRoles returns 403 FORBIDDEN with exact message (TENANT calling LANDLORD)', async () => {
    stub(prisma.user, 'findUnique', async () => tenant1);

    const { response, body } = await requestApp(app, '/api/v1/landlord/properties', {
      headers: { Authorization: `Bearer ${signAccessToken(tenant1.id)}` },
    });

    assert.equal(response.status, 403);
    assert.equal(body.success, false);
    assert.equal(body.code, 'FORBIDDEN');
    assert.equal(body.message, 'Bạn không có quyền thực hiện thao tác này');
    assert.ok(body.traceId);
  });

  test('role not in allowedRoles returns 403 FORBIDDEN (LANDLORD calling TENANT)', async () => {
    stub(prisma.user, 'findUnique', async () => landlord1);

    const { response, body } = await requestApp(app, '/api/v1/tenant/contracts', {
      headers: { Authorization: `Bearer ${signAccessToken(landlord1.id)}` },
    });

    assert.equal(response.status, 403);
    assert.equal(body.success, false);
    assert.equal(body.code, 'FORBIDDEN');
    assert.equal(body.message, 'Bạn không có quyền thực hiện thao tác này');
  });

  test('correct role passes and assigns typed res.locals.currentUser without passwordHash', async () => {
    let capturedSelect: any;
    stub(prisma.user, 'findUnique', async (args: any) => {
      capturedSelect = args?.select;
      return landlord1;
    });

    const { response, body } = await requestApp(app, '/api/v1/landlord/properties', {
      headers: { Authorization: `Bearer ${signAccessToken(landlord1.id)}` },
    });

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.currentUser.id, landlord1.id);
    assert.equal(body.currentUser.role, 'LANDLORD');
    assert.equal(body.currentUser.accountStatus, 'ACTIVE');
    assert.equal(body.currentUser.fullName, landlord1.fullName);

    // Verify Prisma select clause never queries passwordHash
    assert.deepEqual(capturedSelect, {
      id: true,
      role: true,
      accountStatus: true,
      fullName: true,
    });
    assert.equal('passwordHash' in body.currentUser, false);
  });

  test('multi-role route allows both LANDLORD and ADMIN, but rejects TENANT', async () => {
    // 1. Landlord allowed
    stub(prisma.user, 'findUnique', async () => landlord1);
    const res1 = await requestApp(app, '/api/v1/manage/buildings', {
      headers: { Authorization: `Bearer ${signAccessToken(landlord1.id)}` },
    });
    assert.equal(res1.response.status, 200);

    // 2. Admin allowed
    stub(prisma.user, 'findUnique', async () => adminUser);
    const res2 = await requestApp(app, '/api/v1/manage/buildings', {
      headers: { Authorization: `Bearer ${signAccessToken(adminUser.id)}` },
    });
    assert.equal(res2.response.status, 200);

    // 3. Tenant rejected
    stub(prisma.user, 'findUnique', async () => tenant1);
    const res3 = await requestApp(app, '/api/v1/manage/buildings', {
      headers: { Authorization: `Bearer ${signAccessToken(tenant1.id)}` },
    });
    assert.equal(res3.response.status, 403);
    assert.equal(res3.body.code, 'FORBIDDEN');
  });

  test('requireActiveUser accepts any active user role but rejects inactive/deleted users', async () => {
    // Tenant passes
    stub(prisma.user, 'findUnique', async () => tenant1);
    const resTenant = await requestApp(app, '/api/v1/profile/active', {
      headers: { Authorization: `Bearer ${signAccessToken(tenant1.id)}` },
    });
    assert.equal(resTenant.response.status, 200);

    // Landlord passes
    stub(prisma.user, 'findUnique', async () => landlord2);
    const resLandlord = await requestApp(app, '/api/v1/profile/active', {
      headers: { Authorization: `Bearer ${signAccessToken(landlord2.id)}` },
    });
    assert.equal(resLandlord.response.status, 200);

    // Inactive user rejected with 403 ACCOUNT_LOCKED
    stub(prisma.user, 'findUnique', async () => inactiveUser);
    const resInactive = await requestApp(app, '/api/v1/profile/active', {
      headers: { Authorization: `Bearer ${signAccessToken(inactiveUser.id)}` },
    });
    assert.equal(resInactive.response.status, 403);
    assert.equal(resInactive.body.code, 'ACCOUNT_LOCKED');

    // Missing user rejected with 401 UNAUTHORIZED
    stub(prisma.user, 'findUnique', async () => null);
    const resMissing = await requestApp(app, '/api/v1/profile/active', {
      headers: { Authorization: `Bearer ${signAccessToken('unknown-id')}` },
    });
    assert.equal(resMissing.response.status, 401);
    assert.equal(resMissing.body.code, 'UNAUTHORIZED');
  });

  test('missing or malformed access token returns 401 UNAUTHORIZED', async () => {
    // Missing token
    const resNoToken = await requestApp(app, '/api/v1/landlord/properties');
    assert.equal(resNoToken.response.status, 401);
    assert.equal(resNoToken.body.code, 'UNAUTHORIZED');

    // Malformed token
    const resBadToken = await requestApp(app, '/api/v1/landlord/properties', {
      headers: { Authorization: 'Bearer not-a-valid-jwt' },
    });
    assert.equal(resBadToken.response.status, 401);
    assert.equal(resBadToken.body.code, 'UNAUTHORIZED');
  });
});

describe('Ownership Scoping & Anti-Enumeration (2 Landlords, 2 Tenants, 1 Inactive, 1 Admin)', () => {
  const app = createTestApp();

  const property1 = {
    id: 'prop-1-uuid',
    landlordId: landlord1.id,
    name: 'Khu Tro Hoa Mai',
    address: '123 Vo Van Ngan',
    status: 'ACTIVE',
  };

  const property2 = {
    id: 'prop-2-uuid',
    landlordId: landlord2.id,
    name: 'Khu Tro Lan Rung',
    address: '456 Le Van Viet',
    status: 'ACTIVE',
  };

  const room1 = {
    id: 'room-1-uuid',
    propertyId: property1.id,
    roomCode: 'P101',
    monthlyRent: 3000000,
    property: property1,
  };

  const room2 = {
    id: 'room-2-uuid',
    propertyId: property2.id,
    roomCode: 'P202',
    monthlyRent: 4000000,
    property: property2,
  };

  const appointment1 = {
    id: 'apt-1-uuid',
    roomId: room1.id,
    tenantId: tenant1.id,
    status: 'CONFIRMED',
    room: room1,
  };

  const appointment2 = {
    id: 'apt-2-uuid',
    roomId: room2.id,
    tenantId: tenant2.id,
    status: 'PENDING',
    room: room2,
  };

  const rentalRequest1 = {
    id: 'req-1-uuid',
    roomId: room1.id,
    tenantId: tenant1.id,
    status: 'PENDING',
    room: room1,
  };

  const rentalRequest2 = {
    id: 'req-2-uuid',
    roomId: room2.id,
    tenantId: tenant2.id,
    status: 'PENDING',
    room: room2,
  };

  test('Landlord 1 accesses Landlord 1 property -> 200 OK', async () => {
    stub(prisma.user, 'findUnique', async () => landlord1);
    stub(prisma.property, 'findFirst', async ({ where }: any) => {
      assert.equal(where.id, property1.id);
      assert.equal(where.landlordId, landlord1.id);
      return property1;
    });

    const { response, body } = await requestApp(app, `/api/v1/landlord/properties/${property1.id}`, {
      headers: { Authorization: `Bearer ${signAccessToken(landlord1.id)}` },
    });

    assert.equal(response.status, 200);
    assert.equal(body.property.id, property1.id);
  });

  test("Landlord 1 accesses Landlord 2 property -> 404 PROPERTY_NOT_FOUND (Anti-Enumeration)", async () => {
    stub(prisma.user, 'findUnique', async () => landlord1);
    stub(prisma.property, 'findFirst', async ({ where }: any) => {
      // Landlord 1 is querying with where.landlordId = landlord1.id
      assert.equal(where.id, property2.id);
      assert.equal(where.landlordId, landlord1.id);
      return null; // Property 2 belongs to Landlord 2, so query returns null
    });

    const { response, body } = await requestApp(app, `/api/v1/landlord/properties/${property2.id}`, {
      headers: { Authorization: `Bearer ${signAccessToken(landlord1.id)}` },
    });

    assert.equal(response.status, 404);
    assert.equal(body.code, 'PROPERTY_NOT_FOUND');
    assert.equal(body.message, 'Khu trọ không tồn tại hoặc bạn không có quyền truy cập');
    assert.ok(body.traceId);
  });

  test('Landlord 1 accesses Landlord 1 room -> 200 OK', async () => {
    stub(prisma.user, 'findUnique', async () => landlord1);
    stub(prisma.room, 'findFirst', async ({ where }: any) => {
      assert.equal(where.id, room1.id);
      assert.equal(where.property.landlordId, landlord1.id);
      return room1;
    });

    const { response, body } = await requestApp(app, `/api/v1/landlord/rooms/${room1.id}`, {
      headers: { Authorization: `Bearer ${signAccessToken(landlord1.id)}` },
    });

    assert.equal(response.status, 200);
    assert.equal(body.room.id, room1.id);
  });

  test("Landlord 1 accesses Landlord 2 room -> 404 ROOM_NOT_FOUND", async () => {
    stub(prisma.user, 'findUnique', async () => landlord1);
    stub(prisma.room, 'findFirst', async ({ where }: any) => {
      assert.equal(where.id, room2.id);
      assert.equal(where.property.landlordId, landlord1.id);
      return null;
    });

    const { response, body } = await requestApp(app, `/api/v1/landlord/rooms/${room2.id}`, {
      headers: { Authorization: `Bearer ${signAccessToken(landlord1.id)}` },
    });

    assert.equal(response.status, 404);
    assert.equal(body.code, 'ROOM_NOT_FOUND');
    assert.equal(body.message, 'Phòng trọ không tồn tại hoặc bạn không có quyền truy cập');
  });

  test('Tenant 1 accesses Tenant 1 viewing appointment -> 200 OK', async () => {
    stub(prisma.user, 'findUnique', async () => tenant1);
    stub(prisma.viewingAppointment, 'findFirst', async ({ where }: any) => {
      assert.equal(where.id, appointment1.id);
      assert.equal(where.tenantId, tenant1.id);
      return appointment1;
    });

    const { response, body } = await requestApp(app, `/api/v1/appointments/${appointment1.id}`, {
      headers: { Authorization: `Bearer ${signAccessToken(tenant1.id)}` },
    });

    assert.equal(response.status, 200);
    assert.equal(body.appointment.id, appointment1.id);
  });

  test("Tenant 1 accesses Tenant 2 viewing appointment -> 404 APPOINTMENT_NOT_FOUND", async () => {
    stub(prisma.user, 'findUnique', async () => tenant1);
    stub(prisma.viewingAppointment, 'findFirst', async ({ where }: any) => {
      assert.equal(where.id, appointment2.id);
      assert.equal(where.tenantId, tenant1.id);
      return null;
    });

    const { response, body } = await requestApp(app, `/api/v1/appointments/${appointment2.id}`, {
      headers: { Authorization: `Bearer ${signAccessToken(tenant1.id)}` },
    });

    assert.equal(response.status, 404);
    assert.equal(body.code, 'APPOINTMENT_NOT_FOUND');
    assert.equal(body.message, 'Lịch hẹn không tồn tại hoặc bạn không có quyền truy cập');
  });

  test('Landlord 1 accesses viewing appointment for room in their property -> 200 OK', async () => {
    stub(prisma.user, 'findUnique', async () => landlord1);
    stub(prisma.viewingAppointment, 'findFirst', async ({ where }: any) => {
      assert.equal(where.id, appointment1.id);
      assert.equal(where.room.property.landlordId, landlord1.id);
      return appointment1;
    });

    const { response, body } = await requestApp(app, `/api/v1/appointments/${appointment1.id}`, {
      headers: { Authorization: `Bearer ${signAccessToken(landlord1.id)}` },
    });

    assert.equal(response.status, 200);
    assert.equal(body.appointment.id, appointment1.id);
  });

  test("Landlord 2 accesses viewing appointment for room in Landlord 1 property -> 404 APPOINTMENT_NOT_FOUND", async () => {
    stub(prisma.user, 'findUnique', async () => landlord2);
    stub(prisma.viewingAppointment, 'findFirst', async ({ where }: any) => {
      assert.equal(where.id, appointment1.id);
      assert.equal(where.room.property.landlordId, landlord2.id);
      return null;
    });

    const { response, body } = await requestApp(app, `/api/v1/appointments/${appointment1.id}`, {
      headers: { Authorization: `Bearer ${signAccessToken(landlord2.id)}` },
    });

    assert.equal(response.status, 404);
    assert.equal(body.code, 'APPOINTMENT_NOT_FOUND');
    assert.equal(body.message, 'Lịch hẹn không tồn tại hoặc bạn không có quyền truy cập');
  });

  test('Tenant 1 accesses Tenant 1 rental request -> 200 OK', async () => {
    stub(prisma.user, 'findUnique', async () => tenant1);
    stub(prisma.rentalRequest, 'findFirst', async ({ where }: any) => {
      assert.equal(where.id, rentalRequest1.id);
      assert.equal(where.tenantId, tenant1.id);
      return rentalRequest1;
    });

    const { response, body } = await requestApp(app, `/api/v1/rental-requests/${rentalRequest1.id}`, {
      headers: { Authorization: `Bearer ${signAccessToken(tenant1.id)}` },
    });

    assert.equal(response.status, 200);
    assert.equal(body.rentalRequest.id, rentalRequest1.id);
  });

  test("Tenant 1 accesses Tenant 2 rental request -> 404 RENTAL_REQUEST_NOT_FOUND", async () => {
    stub(prisma.user, 'findUnique', async () => tenant1);
    stub(prisma.rentalRequest, 'findFirst', async ({ where }: any) => {
      assert.equal(where.id, rentalRequest2.id);
      assert.equal(where.tenantId, tenant1.id);
      return null;
    });

    const { response, body } = await requestApp(app, `/api/v1/rental-requests/${rentalRequest2.id}`, {
      headers: { Authorization: `Bearer ${signAccessToken(tenant1.id)}` },
    });

    assert.equal(response.status, 404);
    assert.equal(body.code, 'RENTAL_REQUEST_NOT_FOUND');
    assert.equal(body.message, 'Yêu cầu thuê không tồn tại hoặc bạn không có quyền truy cập');
  });

  test('Landlord 1 accesses rental request for room in their property -> 200 OK', async () => {
    stub(prisma.user, 'findUnique', async () => landlord1);
    stub(prisma.rentalRequest, 'findFirst', async ({ where }: any) => {
      assert.equal(where.id, rentalRequest1.id);
      assert.equal(where.room.property.landlordId, landlord1.id);
      return rentalRequest1;
    });

    const { response, body } = await requestApp(app, `/api/v1/rental-requests/${rentalRequest1.id}`, {
      headers: { Authorization: `Bearer ${signAccessToken(landlord1.id)}` },
    });

    assert.equal(response.status, 200);
    assert.equal(body.rentalRequest.id, rentalRequest1.id);
  });

  test("Landlord 2 accesses rental request for room in Landlord 1 property -> 404 RENTAL_REQUEST_NOT_FOUND", async () => {
    stub(prisma.user, 'findUnique', async () => landlord2);
    stub(prisma.rentalRequest, 'findFirst', async ({ where }: any) => {
      assert.equal(where.id, rentalRequest1.id);
      assert.equal(where.room.property.landlordId, landlord2.id);
      return null;
    });

    const { response, body } = await requestApp(app, `/api/v1/rental-requests/${rentalRequest1.id}`, {
      headers: { Authorization: `Bearer ${signAccessToken(landlord2.id)}` },
    });

    assert.equal(response.status, 404);
    assert.equal(body.code, 'RENTAL_REQUEST_NOT_FOUND');
    assert.equal(body.message, 'Yêu cầu thuê không tồn tại hoặc bạn không có quyền truy cập');
  });

  test('ADMIN does NOT bypass ownership scoping -> 404 NOT_FOUND when resource is not owned', async () => {
    stub(prisma.user, 'findUnique', async () => adminUser);
    stub(prisma.property, 'findFirst', async ({ where }: any) => {
      // Query is still scoped by user ID (admin's ID), which does not own property 1
      assert.equal(where.landlordId, adminUser.id);
      return null;
    });

    const { response, body } = await requestApp(app, `/api/v1/landlord/properties/${property1.id}`, {
      headers: { Authorization: `Bearer ${signAccessToken(adminUser.id)}` },
    });

    assert.equal(response.status, 404);
    assert.equal(body.code, 'PROPERTY_NOT_FOUND');
    assert.equal(body.message, 'Khu trọ không tồn tại hoặc bạn không có quyền truy cập');
  });
});
