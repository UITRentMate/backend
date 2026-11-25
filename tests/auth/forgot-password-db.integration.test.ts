import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';

import { errorHandler } from '../../src/common/middleware/error-handler';
import { prisma } from '../../src/infrastructure/database/prisma';
import type { EmailSender, SendPasswordResetEmailParams } from '../../src/infrastructure/mail/email.service';
import { createAuthRoutes } from '../../src/modules/auth/auth.routes';
import { sha256Hex } from '../../src/modules/auth/auth.security';
import { FORGOT_PASSWORD_NEUTRAL_RESPONSE } from '../../src/modules/auth/auth.service';

async function sendForgotPasswordRequest(targetApp: express.Express, email: string) {
  const server = http.createServer(targetApp);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const text = await response.text();
    const body = response.headers.get('content-type')?.includes('application/json')
      ? (JSON.parse(text) as Record<string, any>)
      : {};
    return { response, body };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test('Live DB: forgot-password stores SHA-256 tokenHash, respects cooldown, invalidates prior token & rolls back on SMTP failure', async (t) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    t.skip('PostgreSQL is not available');
    return;
  }

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const email = `forgot-db-${suffix}@rentmate.test`;
  const phone = `09${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`;
  let userId: string | undefined;

  const sentEmails: SendPasswordResetEmailParams[] = [];
  let shouldFailSend = false;

  const mockSender: EmailSender = {
    async sendPasswordResetEmail(params) {
      if (shouldFailSend) {
        throw new Error('Simulated SMTP outage');
      }
      sentEmails.push(params);
    },
  };

  const testApp = express();
  testApp.use(express.json());
  testApp.use('/api/v1/auth', createAuthRoutes({ emailSender: mockSender }));
  testApp.use(errorHandler);

  try {
    const user = await prisma.user.create({
      data: {
        fullName: 'Forgot Password DB Test',
        email,
        phone,
        passwordHash: 'test-only',
        role: 'TENANT',
        accountStatus: 'ACTIVE',
      },
    });
    userId = user.id;

    // 1. Yêu cầu lần 1 -> tạo token mới và gửi mail
    const firstRes = await sendForgotPasswordRequest(testApp, email);
    assert.equal(firstRes.response.status, 200);
    assert.deepEqual(firstRes.body, FORGOT_PASSWORD_NEUTRAL_RESPONSE);
    assert.equal(sentEmails.length, 1);

    const rawToken1 = new URL(sentEmails[0].resetUrl).searchParams.get('token')!;
    assert.match(rawToken1, /^[0-9a-f]{64}$/);

    const tokensAfterFirst = await prisma.passwordResetToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(tokensAfterFirst.length, 1);
    assert.equal(tokensAfterFirst[0].tokenHash, sha256Hex(rawToken1));
    assert.notEqual(tokensAfterFirst[0].tokenHash, rawToken1);
    assert.equal(tokensAfterFirst[0].usedAt, null);
    assert.equal(
      tokensAfterFirst[0].expiresAt.getTime() > tokensAfterFirst[0].createdAt.getTime(),
      true,
    );

    // 2. Yêu cầu trong thời gian cooldown (< 60s) -> không tạo thêm token, không gửi mail
    const cooldownRes = await sendForgotPasswordRequest(testApp, email);
    assert.equal(cooldownRes.response.status, 200);
    assert.deepEqual(cooldownRes.body, FORGOT_PASSWORD_NEUTRAL_RESPONSE);
    assert.equal(sentEmails.length, 1);
    assert.equal(await prisma.passwordResetToken.count({ where: { userId } }), 1);

    // 3. Mô phỏng đã qua > 60s -> yêu cầu lần 2 vô hiệu hóa token 1 và tạo token 2
    await prisma.passwordResetToken.update({
      where: { id: tokensAfterFirst[0].id },
      data: { createdAt: new Date(Date.now() - 61 * 1000) },
    });

    const secondRes = await sendForgotPasswordRequest(testApp, email);
    assert.equal(secondRes.response.status, 200);
    assert.deepEqual(secondRes.body, FORGOT_PASSWORD_NEUTRAL_RESPONSE);
    assert.equal(sentEmails.length, 2);

    const rawToken2 = new URL(sentEmails[1].resetUrl).searchParams.get('token')!;
    assert.match(rawToken2, /^[0-9a-f]{64}$/);
    assert.notEqual(rawToken2, rawToken1);

    const tokensAfterSecond = await prisma.passwordResetToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(tokensAfterSecond.length, 2);
    assert.ok(tokensAfterSecond[0].usedAt !== null, 'Token thứ nhất phải bị đánh dấu đã dùng');
    assert.equal(tokensAfterSecond[1].tokenHash, sha256Hex(rawToken2));
    assert.equal(tokensAfterSecond[1].usedAt, null);

    // 4. Mô phỏng lỗi SMTP sau > 60s -> rollback (thu hồi token vừa phát hành) và trả 500
    await prisma.passwordResetToken.update({
      where: { id: tokensAfterSecond[1].id },
      data: { createdAt: new Date(Date.now() - 61 * 1000) },
    });

    shouldFailSend = true;
    const smtpFailRes = await sendForgotPasswordRequest(testApp, email);
    assert.equal(smtpFailRes.response.status, 500);
    assert.equal(smtpFailRes.body.code, 'INTERNAL_ERROR');

    const tokensAfterFailure = await prisma.passwordResetToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(tokensAfterFailure.length, 3);
    assert.ok(tokensAfterFailure[2].usedAt !== null, 'Token mới tạo phải bị thu hồi khi SMTP lỗi');
  } finally {
    if (userId) {
      await prisma.passwordResetToken.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
});
