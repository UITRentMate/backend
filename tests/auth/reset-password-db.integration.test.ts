import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import bcrypt from 'bcrypt';
import express from 'express';

import { errorHandler } from '../../src/common/middleware/error-handler';
import { prisma } from '../../src/infrastructure/database/prisma';
import type { EmailSender, SendPasswordResetEmailParams } from '../../src/infrastructure/mail/email.service';
import { createAuthRoutes } from '../../src/modules/auth/auth.routes';
import { newPasswordResetToken, sha256Hex } from '../../src/modules/auth/auth.security';

async function isDatabaseAvailable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

function extractRefreshCookieValue(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(/refreshToken=([^;]+)/);
  return match ? match[1] : null;
}

async function sendAuthRequest(
  targetApp: express.Express,
  path: string,
  body?: unknown,
  cookie?: string,
) {
  const server = http.createServer(targetApp);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (cookie) {
      headers.Cookie = cookie;
    }

    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const json = response.headers.get('content-type')?.includes('application/json')
      ? (JSON.parse(text) as Record<string, any>)
      : {};
    return { response, body: json };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe('Live DB: POST /api/v1/auth/reset-password', () => {
  test('forgot -> reset -> mật khẩu cũ 401, mật khẩu mới 200, refresh token cũ 401 và lưu audit log PASSWORD_RESET_COMPLETED', async (t) => {
    if (!(await isDatabaseAvailable())) {
      t.skip('PostgreSQL is not available');
      return;
    }

    const previousJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET ??= 'test-secret-must-have-at-least-thirty-two-bytes';

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const email = `reset-db-${suffix}@rentmate.test`;
    const phone = `09${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`;
    const oldPassword = 'OldPassword@123';
    const newPassword = 'NewPassword@456';
    let userId: string | undefined;

    const sentEmails: SendPasswordResetEmailParams[] = [];
    const mockSender: EmailSender = {
      async sendPasswordResetEmail(params) {
        sentEmails.push(params);
      },
    };

    const testApp = express();
    testApp.use(express.json());
    testApp.use('/api/v1/auth', createAuthRoutes({ emailSender: mockSender }));
    testApp.use(errorHandler);

    try {
      const oldHash = await bcrypt.hash(oldPassword, 10);
      const user = await prisma.user.create({
        data: {
          fullName: 'Reset Password DB Test',
          email,
          phone,
          passwordHash: oldHash,
          role: 'TENANT',
          accountStatus: 'ACTIVE',
        },
      });
      userId = user.id;

      // Đăng nhập trước để có refresh token đang hoạt động
      const loginBefore = await sendAuthRequest(testApp, '/api/v1/auth/login', {
        username: email,
        password: oldPassword,
      });
      assert.equal(loginBefore.response.status, 200);
      const oldRefreshToken = extractRefreshCookieValue(loginBefore.response.headers.get('set-cookie'));
      assert.ok(oldRefreshToken);

      // 1. Gọi forgot-password lấy rawToken
      const forgotRes = await sendAuthRequest(testApp, '/api/v1/auth/forgot-password', { email });
      assert.equal(forgotRes.response.status, 200);
      assert.equal(sentEmails.length, 1);

      const rawToken = new URL(sentEmails[0].resetUrl).searchParams.get('token')!;
      assert.match(rawToken, /^[0-9a-f]{64}$/);

      // 2. Gọi reset-password
      const resetRes = await sendAuthRequest(testApp, '/api/v1/auth/reset-password', {
        token: rawToken,
        newPassword,
        confirmNewPassword: newPassword,
      });
      assert.equal(resetRes.response.status, 200);
      assert.deepEqual(resetRes.body, {
        success: true,
        message: 'Đặt lại mật khẩu thành công. Vui lòng đăng nhập lại.',
      });

      const resetSetCookie = resetRes.response.headers.get('set-cookie');
      assert.ok(resetSetCookie);
      assert.match(resetSetCookie, /Max-Age=0/i);
      assert.match(resetSetCookie, /Path=\/api\/v1\/auth/i);

      // 3. Mật khẩu cũ không còn đăng nhập được (401)
      const oldLoginRes = await sendAuthRequest(testApp, '/api/v1/auth/login', {
        username: email,
        password: oldPassword,
      });
      assert.equal(oldLoginRes.response.status, 401);

      // 4. Mật khẩu mới đăng nhập thành công (200)
      const newLoginRes = await sendAuthRequest(testApp, '/api/v1/auth/login', {
        username: email,
        password: newPassword,
      });
      assert.equal(newLoginRes.response.status, 200);
      assert.ok(newLoginRes.body.accessToken);

      // 5. Refresh token cũ bị thu hồi, gọi /refresh thất bại (401)
      const refreshOldRes = await sendAuthRequest(
        testApp,
        '/api/v1/auth/refresh',
        undefined,
        `refreshToken=${oldRefreshToken}`,
      );
      assert.equal(refreshOldRes.response.status, 401);

      // 6. AuditLog PASSWORD_RESET_COMPLETED được lưu không lộ bí mật
      const tokenRow = await prisma.passwordResetToken.findUnique({
        where: { tokenHash: sha256Hex(rawToken) },
      });
      assert.ok(tokenRow);
      assert.ok(tokenRow.usedAt !== null);

      const auditLogs = await prisma.auditLog.findMany({
        where: {
          entityType: 'User',
          entityId: userId,
          action: 'PASSWORD_RESET_COMPLETED',
        },
      });
      assert.equal(auditLogs.length, 1);
      assert.equal(auditLogs[0].actorId, userId);
      assert.deepEqual(auditLogs[0].newData, {
        sessionsRevoked: true,
        resetTokenId: tokenRow.id,
      });
    } finally {
      if (previousJwtSecret === undefined) {
        delete process.env.JWT_SECRET;
      } else {
        process.env.JWT_SECRET = previousJwtSecret;
      }
      if (userId) {
        await prisma.auditLog.deleteMany({ where: { actorId: userId } });
        await prisma.refreshSession.deleteMany({ where: { userId } });
        await prisma.passwordResetToken.deleteMany({ where: { userId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }
    }
  });

  test('token hết hạn hoặc dùng lại đều trả 400 INVALID_OR_EXPIRED_RESET_TOKEN', async (t) => {
    if (!(await isDatabaseAvailable())) {
      t.skip('PostgreSQL is not available');
      return;
    }

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const email = `reset-exp-db-${suffix}@rentmate.test`;
    const phone = `09${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`;
    const initialPassword = 'InitPassword@123';
    const nextPassword = 'NextPassword@123';
    let userId: string | undefined;

    const testApp = express();
    testApp.use(express.json());
    testApp.use('/api/v1/auth', createAuthRoutes());
    testApp.use(errorHandler);

    try {
      const user = await prisma.user.create({
        data: {
          fullName: 'Expired/Reused Reset DB Test',
          email,
          phone,
          passwordHash: await bcrypt.hash(initialPassword, 10),
          role: 'TENANT',
          accountStatus: 'ACTIVE',
        },
      });
      userId = user.id;

      // Token hết hạn
      const expiredPair = newPasswordResetToken();
      await prisma.passwordResetToken.create({
        data: {
          userId,
          tokenHash: expiredPair.tokenHash,
          expiresAt: new Date(Date.now() - 60 * 1000),
        },
      });

      const expiredRes = await sendAuthRequest(testApp, '/api/v1/auth/reset-password', {
        token: expiredPair.rawToken,
        newPassword: nextPassword,
        confirmPassword: nextPassword,
      });
      assert.equal(expiredRes.response.status, 400);
      assert.equal(expiredRes.body.code, 'INVALID_OR_EXPIRED_RESET_TOKEN');

      // Token hợp lệ dùng 1 lần rồi dùng lại lần 2
      const validPair = newPasswordResetToken();
      await prisma.passwordResetToken.create({
        data: {
          userId,
          tokenHash: validPair.tokenHash,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      });

      const firstUse = await sendAuthRequest(testApp, '/api/v1/auth/reset-password', {
        token: validPair.rawToken,
        newPassword: nextPassword,
        confirmNewPassword: nextPassword,
      });
      assert.equal(firstUse.response.status, 200);

      const secondUse = await sendAuthRequest(testApp, '/api/v1/auth/reset-password', {
        token: validPair.rawToken,
        newPassword: 'AnotherPassword@789',
        confirmNewPassword: 'AnotherPassword@789',
      });
      assert.equal(secondUse.response.status, 400);
      assert.equal(secondUse.body.code, 'INVALID_OR_EXPIRED_RESET_TOKEN');

      const refreshedUser = await prisma.user.findUnique({ where: { id: userId } });
      assert.ok(refreshedUser);
      assert.equal(await bcrypt.compare(nextPassword, refreshedUser.passwordHash), true);
    } finally {
      if (userId) {
        await prisma.auditLog.deleteMany({ where: { actorId: userId } });
        await prisma.refreshSession.deleteMany({ where: { userId } });
        await prisma.passwordResetToken.deleteMany({ where: { userId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }
    }
  });

  test('gửi đồng thời 2 request reset-password cùng 1 token: đúng 1 thành công (200) và 1 bị từ chối (400 INVALID_OR_EXPIRED_RESET_TOKEN)', async (t) => {
    if (!(await isDatabaseAvailable())) {
      t.skip('PostgreSQL is not available');
      return;
    }

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const email = `reset-race-db-${suffix}@rentmate.test`;
    const phone = `09${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`;
    let userId: string | undefined;

    const testApp = express();
    testApp.use(express.json());
    testApp.use('/api/v1/auth', createAuthRoutes());
    testApp.use(errorHandler);

    const server = http.createServer(testApp);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const user = await prisma.user.create({
        data: {
          fullName: 'Concurrent Reset DB Test',
          email,
          phone,
          passwordHash: await bcrypt.hash('OldRacePass@123', 10),
          role: 'TENANT',
          accountStatus: 'ACTIVE',
        },
      });
      userId = user.id;

      const pair = newPasswordResetToken();
      await prisma.passwordResetToken.create({
        data: {
          userId,
          tokenHash: pair.tokenHash,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      });

      const sendConcurrent = async (newPassword: string) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: pair.rawToken,
            newPassword,
            confirmNewPassword: newPassword,
          }),
        });
        const body = (await response.json()) as Record<string, any>;
        return { status: response.status, body };
      };

      const results = await Promise.all([
        sendConcurrent('ConcurrentPassA@123'),
        sendConcurrent('ConcurrentPassB@456'),
      ]);

      const successes = results.filter((r) => r.status === 200);
      const failures = results.filter((r) => r.status === 400);

      assert.equal(successes.length, 1);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].body.code, 'INVALID_OR_EXPIRED_RESET_TOKEN');

      const auditCount = await prisma.auditLog.count({
        where: {
          actorId: userId,
          action: 'PASSWORD_RESET_COMPLETED',
        },
      });
      assert.equal(auditCount, 1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      if (userId) {
        await prisma.auditLog.deleteMany({ where: { actorId: userId } });
        await prisma.refreshSession.deleteMany({ where: { userId } });
        await prisma.passwordResetToken.deleteMany({ where: { userId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }
    }
  });
});
