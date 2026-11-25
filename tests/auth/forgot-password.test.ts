import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, test } from 'node:test';
import express from 'express';

import { app } from '../../src/app';
import { errorHandler } from '../../src/common/middleware/error-handler';
import { getFrontendResetPasswordUrl } from '../../src/config/env';
import { prisma } from '../../src/infrastructure/database/prisma';
import type { EmailSender, SendPasswordResetEmailParams } from '../../src/infrastructure/mail/email.service';
import { createAuthRoutes } from '../../src/modules/auth/auth.routes';
import { buildPasswordResetUrl, newPasswordResetToken, sha256Hex } from '../../src/modules/auth/auth.security';
import { FORGOT_PASSWORD_NEUTRAL_RESPONSE } from '../../src/modules/auth/auth.service';

const undo: Array<() => void> = [];

afterEach(() => {
  while (undo.length > 0) {
    undo.pop()!();
  }
});

function stub<T extends object, K extends keyof T>(target: T, key: K, impl: T[K]) {
  const original = target[key];
  target[key] = impl;
  undo.push(() => {
    target[key] = original;
  });
}

function setEnvTemp(key: string, value: string | undefined) {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  undo.push(() => {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  });
}

async function sendRequest(targetApp: express.Express, path: string, body: unknown) {
  const server = http.createServer(targetApp);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const json = response.headers.get('content-type')?.includes('application/json')
      ? (JSON.parse(text) as Record<string, any>)
      : {};
    return { response, body: json, text };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function createAppWithEmailSender(emailSender: EmailSender) {
  const testApp = express();
  testApp.use(express.json());
  testApp.use('/api/v1/auth', createAuthRoutes({ emailSender }));
  testApp.use(errorHandler);
  return testApp;
}

describe('Forgot Password Helpers', () => {
  test('getFrontendResetPasswordUrl fallback ở non-production và báo lỗi khi URL không hợp lệ', () => {
    assert.equal(getFrontendResetPasswordUrl({ NODE_ENV: 'test' }), 'http://localhost:5173/reset-password');
    assert.equal(
      getFrontendResetPasswordUrl({
        NODE_ENV: 'production',
        FRONTEND_RESET_PASSWORD_URL: '  https://rentmate.example.com/reset-password  ',
      }),
      'https://rentmate.example.com/reset-password',
    );
    assert.throws(
      () => getFrontendResetPasswordUrl({ NODE_ENV: 'production' }),
      /FRONTEND_RESET_PASSWORD_URL/,
    );
    assert.throws(
      () => getFrontendResetPasswordUrl({ FRONTEND_RESET_PASSWORD_URL: 'not-a-valid-url' }),
      /Invalid FRONTEND_RESET_PASSWORD_URL/,
    );
    assert.throws(
      () => getFrontendResetPasswordUrl({ FRONTEND_RESET_PASSWORD_URL: 'ftp://localhost:5173/reset' }),
      /Invalid FRONTEND_RESET_PASSWORD_URL/,
    );
  });

  test('newPasswordResetToken tạo 64 ký tự hex và hash SHA-256; buildPasswordResetUrl gắn query token', () => {
    const { rawToken, tokenHash } = newPasswordResetToken();
    assert.match(rawToken, /^[0-9a-f]{64}$/);
    assert.equal(tokenHash, createHash('sha256').update(rawToken).digest('hex'));
    assert.equal(tokenHash, sha256Hex(rawToken));
    assert.notEqual(tokenHash, rawToken);

    const url = buildPasswordResetUrl('http://localhost:5173/reset-password', rawToken);
    assert.equal(url, `http://localhost:5173/reset-password?token=${rawToken}`);
  });
});

describe('POST /api/v1/auth/forgot-password', () => {
  test('trả 400 VALIDATION_ERROR với email rỗng, sai định dạng hoặc thừa field lạ', async () => {
    const invalidPayloads = [
      {},
      { email: '' },
      { email: 'not-an-email' },
      { email: `${'a'.repeat(250)}@example.com` },
      { email: 'user@example.com', extraField: 'unexpected' },
    ];

    for (const payload of invalidPayloads) {
      const { response, body } = await sendRequest(app, '/api/v1/auth/forgot-password', payload);
      assert.equal(response.status, 400);
      assert.equal(body.success, false);
      assert.equal(body.code, 'VALIDATION_ERROR');
    }
  });

  test('email không tồn tại trả về 200 trung tính, không tạo token và không gọi emailSender', async () => {
    let emailCalled = false;
    let txCalled = false;
    const mockSender: EmailSender = {
      async sendPasswordResetEmail() {
        emailCalled = true;
      },
    };

    stub(prisma.user, 'findUnique', async () => null);
    stub(prisma, '$transaction', async () => {
      txCalled = true;
      throw new Error('Should not create token');
    });

    const testApp = createAppWithEmailSender(mockSender);
    const { response, body } = await sendRequest(testApp, '/api/v1/auth/forgot-password', {
      email: 'missing@example.com',
    });

    assert.equal(response.status, 200);
    assert.deepEqual(body, FORGOT_PASSWORD_NEUTRAL_RESPONSE);
    assert.equal(emailCalled, false);
    assert.equal(txCalled, false);
  });

  test('tài khoản LOCKED hoặc INACTIVE trả về 200 trung tính giống nhau, không tạo token và không gửi mail', async () => {
    for (const accountStatus of ['LOCKED', 'INACTIVE']) {
      let emailCalled = false;
      let txCalled = false;
      const mockSender: EmailSender = {
        async sendPasswordResetEmail() {
          emailCalled = true;
        },
      };

      stub(prisma.user, 'findUnique', async () => ({
        id: '550e8400-e29b-41d4-a716-446655440010',
        email: 'locked@example.com',
        fullName: 'Locked User',
        accountStatus,
      }) as any);
      stub(prisma, '$transaction', async () => {
        txCalled = true;
        throw new Error('Should not create token');
      });

      const testApp = createAppWithEmailSender(mockSender);
      const { response, body } = await sendRequest(testApp, '/api/v1/auth/forgot-password', {
        email: 'locked@example.com',
      });

      assert.equal(response.status, 200);
      assert.deepEqual(body, FORGOT_PASSWORD_NEUTRAL_RESPONSE);
      assert.equal(emailCalled, false);
      assert.equal(txCalled, false);
    }
  });

  test('tài khoản ACTIVE lưu SHA-256 tokenHash, vô hiệu hóa token cũ, gửi resetUrl với expiresInMinutes=15 và không lộ rawToken', async () => {
    setEnvTemp('FRONTEND_RESET_PASSWORD_URL', 'https://app.rentmate.local/reset-password');

    const sentEmails: SendPasswordResetEmailParams[] = [];
    let updateManyArgs: any;
    let createArgs: any;
    let findUniqueWhere: any;

    const mockSender: EmailSender = {
      async sendPasswordResetEmail(params) {
        sentEmails.push(params);
      },
    };

    stub(prisma.user, 'findUnique', async (args: any) => {
      findUniqueWhere = args.where;
      return {
        id: '550e8400-e29b-41d4-a716-446655440001',
        email: 'active.user@example.com',
        fullName: 'Nguyen Van Active',
        accountStatus: 'ACTIVE',
      } as any;
    });
    stub((prisma as any).passwordResetToken, 'findFirst', async () => null);
    stub(prisma, '$transaction', async (run: any) => run(prisma));
    stub((prisma as any).passwordResetToken, 'updateMany', async (args: any) => {
      updateManyArgs = args;
      return { count: 1 };
    });
    stub((prisma as any).passwordResetToken, 'create', async (args: any) => {
      createArgs = args;
      return {
        id: 'token-row-1',
        expiresAt: args.data.expiresAt,
      };
    });

    const testApp = createAppWithEmailSender(mockSender);
    const { response, body, text } = await sendRequest(testApp, '/api/v1/auth/forgot-password', {
      email: '  Active.User@Example.com  ',
    });

    assert.equal(response.status, 200);
    assert.deepEqual(body, FORGOT_PASSWORD_NEUTRAL_RESPONSE);
    assert.deepEqual(findUniqueWhere, { email: 'active.user@example.com' });

    assert.deepEqual(updateManyArgs.where, {
      userId: '550e8400-e29b-41d4-a716-446655440001',
      usedAt: null,
    });
    assert.ok(updateManyArgs.data.usedAt instanceof Date);

    assert.equal(sentEmails.length, 1);
    const sent = sentEmails[0];
    assert.equal(sent.to, 'active.user@example.com');
    assert.equal(sent.fullName, 'Nguyen Van Active');
    assert.equal(sent.expiresInMinutes, 15);

    const parsedResetUrl = new URL(sent.resetUrl);
    assert.equal(parsedResetUrl.origin + parsedResetUrl.pathname, 'https://app.rentmate.local/reset-password');
    const rawToken = parsedResetUrl.searchParams.get('token');
    assert.ok(rawToken);
    assert.match(rawToken, /^[0-9a-f]{64}$/);

    assert.equal(createArgs.data.userId, '550e8400-e29b-41d4-a716-446655440001');
    assert.equal(createArgs.data.tokenHash, sha256Hex(rawToken));
    assert.notEqual(createArgs.data.tokenHash, rawToken);
    assert.equal(
      createArgs.data.expiresAt.getTime() - updateManyArgs.data.usedAt.getTime(),
      15 * 60 * 1000,
    );

    assert.equal(text.includes(rawToken), false);
    assert.equal(text.includes(createArgs.data.tokenHash), false);
  });

  test('cooldown < 60 giây trả 200 im lặng không tạo token mới; >= 60 giây tạo token và gửi email', async () => {
    const sentEmails: SendPasswordResetEmailParams[] = [];
    let latestCreatedAt = new Date(Date.now() - 30 * 1000);
    let createCount = 0;

    const mockSender: EmailSender = {
      async sendPasswordResetEmail(params) {
        sentEmails.push(params);
      },
    };

    stub(prisma.user, 'findUnique', async () => ({
      id: '550e8400-e29b-41d4-a716-446655440002',
      email: 'cooldown@example.com',
      fullName: 'Cooldown User',
      accountStatus: 'ACTIVE',
    }) as any);
    stub((prisma as any).passwordResetToken, 'findFirst', async () => ({
      createdAt: latestCreatedAt,
    }));
    stub(prisma, '$transaction', async (run: any) => run(prisma));
    stub((prisma as any).passwordResetToken, 'updateMany', async () => ({ count: 1 }));
    stub((prisma as any).passwordResetToken, 'create', async (args: any) => {
      createCount += 1;
      return { id: `token-${createCount}`, expiresAt: args.data.expiresAt };
    });

    const testApp = createAppWithEmailSender(mockSender);

    const withinCooldown = await sendRequest(testApp, '/api/v1/auth/forgot-password', {
      email: 'cooldown@example.com',
    });
    assert.equal(withinCooldown.response.status, 200);
    assert.deepEqual(withinCooldown.body, FORGOT_PASSWORD_NEUTRAL_RESPONSE);
    assert.equal(createCount, 0);
    assert.equal(sentEmails.length, 0);

    latestCreatedAt = new Date(Date.now() - 60 * 1000);
    const afterCooldown = await sendRequest(testApp, '/api/v1/auth/forgot-password', {
      email: 'cooldown@example.com',
    });
    assert.equal(afterCooldown.response.status, 200);
    assert.deepEqual(afterCooldown.body, FORGOT_PASSWORD_NEUTRAL_RESPONSE);
    assert.equal(createCount, 1);
    assert.equal(sentEmails.length, 1);
  });

  test('lỗi SMTP thu hồi token vừa tạo, log không lộ rawToken/email/credentials và trả 500 INTERNAL_ERROR', async () => {
    let capturedResetUrl = '';
    let revokedWhere: any;
    let revokedData: any;
    const errorLogs: string[] = [];

    const mockSender: EmailSender = {
      async sendPasswordResetEmail(params) {
        capturedResetUrl = params.resetUrl;
        throw new Error(
          `SMTP auth failed user=secret_smtp_user pass=super_secret_pass to=${params.to} url=${params.resetUrl}`,
        );
      },
    };

    stub(console, 'error', (...args: unknown[]) => {
      errorLogs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
    stub(prisma.user, 'findUnique', async () => ({
      id: '550e8400-e29b-41d4-a716-446655440003',
      email: 'smtp-fail@example.com',
      fullName: 'SMTP Fail User',
      accountStatus: 'ACTIVE',
    }) as any);
    stub((prisma as any).passwordResetToken, 'findFirst', async () => null);
    stub(prisma, '$transaction', async (run: any) => run(prisma));
    stub((prisma as any).passwordResetToken, 'updateMany', async (args: any) => {
      if (args.where?.id === 'issued-token-id') {
        revokedWhere = args.where;
        revokedData = args.data;
      }
      return { count: 1 };
    });
    stub((prisma as any).passwordResetToken, 'create', async (args: any) => ({
      id: 'issued-token-id',
      expiresAt: args.data.expiresAt,
    }));

    const testApp = createAppWithEmailSender(mockSender);
    const { response, body, text } = await sendRequest(testApp, '/api/v1/auth/forgot-password', {
      email: 'smtp-fail@example.com',
    });

    assert.equal(response.status, 500);
    assert.equal(body.success, false);
    assert.equal(body.code, 'INTERNAL_ERROR');

    const rawToken = new URL(capturedResetUrl).searchParams.get('token')!;
    assert.ok(rawToken);
    assert.deepEqual(revokedWhere, { id: 'issued-token-id', usedAt: null });
    assert.ok(revokedData.usedAt instanceof Date);

    assert.ok(errorLogs.length >= 1);
    const combinedLogs = errorLogs.join('\n');
    assert.equal(combinedLogs.includes(rawToken), false);
    assert.equal(combinedLogs.includes('smtp-fail@example.com'), false);
    assert.equal(combinedLogs.includes('secret_smtp_user'), false);
    assert.equal(combinedLogs.includes('super_secret_pass'), false);
    assert.equal(text.includes(rawToken), false);
  });
});
