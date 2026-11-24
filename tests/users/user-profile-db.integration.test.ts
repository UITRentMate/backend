import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import bcrypt from 'bcrypt';
import { app } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { signAccessToken } from '../../src/modules/auth/auth.security';

process.env.JWT_SECRET = 'test-secret-must-have-at-least-thirty-two-bytes';

test('Live DB: GET & PUT /api/v1/users/me profile read, partial update, null clearing, and duplicate phone 409', async (t) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    t.skip('PostgreSQL is not available');
    return;
  }

  const requiredColumns = ['avatar_url', 'date_of_birth', 'address'];
  const columnRows = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'users'
      AND column_name IN ('avatar_url', 'date_of_birth', 'address')
  `;
  const existingColumns = new Set(columnRows.map(({ column_name }) => column_name));
  const missingColumns = requiredColumns.filter((col) => !existingColumns.has(col));
  if (missingColumns.length > 0) {
    t.skip('Phase 3 user profile migration is not applied; missing columns: ' + missingColumns.join(', '));
    return;
  }

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const userIds: string[] = [];
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const phone1 = `09${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`;
    const phone2 = `08${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`;

    const user1 = await prisma.user.create({
      data: {
        fullName: 'Profile Integration User 1',
        email: `p3-profile-1-${suffix}@rentmate.test`,
        phone: phone1,
        passwordHash: 'test-only',
        role: 'TENANT',
        accountStatus: 'ACTIVE',
      },
    });
    userIds.push(user1.id);

    const user2 = await prisma.user.create({
      data: {
        fullName: 'Profile Integration User 2',
        email: `p3-profile-2-${suffix}@rentmate.test`,
        phone: phone2,
        passwordHash: 'test-only',
        role: 'TENANT',
        accountStatus: 'ACTIVE',
      },
    });
    userIds.push(user2.id);

    const token1 = signAccessToken(user1.id);

    // 1. GET /api/v1/users/me returns defaults
    const getRes = await fetch(`${baseUrl}/api/v1/users/me`, {
      headers: { Authorization: `Bearer ${token1}` },
    });
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.deepEqual(getBody, {
      userId: user1.id,
      fullName: 'Profile Integration User 1',
      email: user1.email,
      phone: phone1,
      role: 'TENANT',
      status: 'ACTIVE',
      avatarUrl: null,
      dateOfBirth: null,
      address: null,
    });

    // 2. PUT /api/v1/users/me updates fields cleanly
    const putRes = await fetch(`${baseUrl}/api/v1/users/me`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token1}`,
      },
      body: JSON.stringify({
        fullName: 'Nguyễn Văn Hồ Sơ',
        dateOfBirth: '2001-08-19',
        address: 'TP. Thủ Đức, TP.HCM',
      }),
    });
    assert.equal(putRes.status, 200);
    const putBody = await putRes.json();
    assert.equal(putBody.fullName, 'Nguyễn Văn Hồ Sơ');
    assert.equal(putBody.dateOfBirth, '2001-08-19');
    assert.equal(putBody.address, 'TP. Thủ Đức, TP.HCM');

    // 3. PUT /api/v1/users/me clears dateOfBirth & address with null
    const clearRes = await fetch(`${baseUrl}/api/v1/users/me`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token1}`,
      },
      body: JSON.stringify({
        dateOfBirth: null,
        address: null,
      }),
    });
    assert.equal(clearRes.status, 200);
    const clearBody = await clearRes.json();
    assert.equal(clearBody.dateOfBirth, null);
    assert.equal(clearBody.address, null);

    // 4. PUT /api/v1/users/me rejects duplicate phone with 409 PHONE_ALREADY_EXISTS
    const dupRes = await fetch(`${baseUrl}/api/v1/users/me`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token1}`,
      },
      body: JSON.stringify({
        phone: phone2,
      }),
    });
    assert.equal(dupRes.status, 409);
    const dupBody = await dupRes.json();
    assert.equal(dupBody.code, 'PHONE_ALREADY_EXISTS');
  } finally {
    server.close();
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    }
  }
});

test('Live DB: PATCH /api/v1/users/me/password revokes active refresh sessions so old refresh token gets 401', async (t) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    t.skip('PostgreSQL is not available');
    return;
  }

  const requiredColumns = ['avatar_url', 'date_of_birth', 'address'];
  const columnRows = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'users'
      AND column_name IN ('avatar_url', 'date_of_birth', 'address')
  `;
  const existingColumns = new Set(columnRows.map(({ column_name }) => column_name));
  const missingColumns = requiredColumns.filter((col) => !existingColumns.has(col));
  if (missingColumns.length > 0) {
    t.skip('Phase 3 user profile migration is not applied; missing columns: ' + missingColumns.join(', '));
    return;
  }

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const userIds: string[] = [];
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const oldPassword = 'OldPassword@123';
    const newPassword = 'NewPassword@456';
    const phone = `07${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`;
    const email = `p3-password-${suffix}@rentmate.test`;

    const user = await prisma.user.create({
      data: {
        fullName: 'Password Integration User',
        email,
        phone,
        passwordHash: await bcrypt.hash(oldPassword, 4),
        role: 'TENANT',
        accountStatus: 'ACTIVE',
      },
    });
    userIds.push(user.id);

    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: email, password: oldPassword }),
    });
    assert.equal(loginRes.status, 200);
    const loginBody = await loginRes.json();
    const loginCookieHeader = loginRes.headers.get('set-cookie') ?? '';
    const refreshMatch = /refreshToken=([^;]+)/.exec(loginCookieHeader);
    assert.ok(refreshMatch?.[1], 'Login must issue a refreshToken cookie');
    const oldRefreshCookie = `refreshToken=${refreshMatch[1]}`;

    const changeRes = await fetch(`${baseUrl}/api/v1/users/me/password`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginBody.accessToken}`,
      },
      body: JSON.stringify({
        currentPassword: oldPassword,
        newPassword,
        confirmNewPassword: newPassword,
      }),
    });
    assert.equal(changeRes.status, 200);
    const changeBody = await changeRes.json();
    assert.deepEqual(changeBody, {
      message: 'Đổi mật khẩu thành công. Vui lòng đăng nhập lại',
    });
    const clearedCookie = changeRes.headers.get('set-cookie') ?? '';
    assert.match(clearedCookie, /refreshToken=;/i);
    assert.match(clearedCookie, /Max-Age=0/i);
    assert.match(clearedCookie, /Path=\/api\/v1\/auth/i);

    const refreshRes = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: oldRefreshCookie },
    });
    assert.equal(refreshRes.status, 401);
    const refreshBody = await refreshRes.json();
    assert.equal(refreshBody.code, 'UNAUTHORIZED');

    const auditLogs = await prisma.auditLog.findMany({
      where: { entityType: 'User', entityId: user.id, action: 'PASSWORD_CHANGED' },
    });
    assert.equal(auditLogs.length, 1);
    assert.equal(auditLogs[0].actorId, user.id);
    assert.deepEqual(auditLogs[0].newData, { sessionsRevoked: true });
  } finally {
    server.close();
    if (userIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { entityId: { in: userIds } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    }
  }
});
