import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, test } from 'node:test';
import bcrypt from 'bcrypt';
import express from 'express';

import { app } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { newPasswordResetToken, sha256Hex } from '../../src/modules/auth/auth.security';
import { parseResetPassword } from '../../src/modules/auth/auth.validation';

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

async function sendResetRequest(targetApp: express.Express, body: unknown) {
  const server = http.createServer(targetApp);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/reset-password`, {
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

describe('Reset Password Validation', () => {
  test('parseResetPassword chấp nhận confirmPassword, confirmNewPassword hoặc cả hai khi trùng khớp', () => {
    const validPassword = 'NewPassword@123';

    assert.deepEqual(
      parseResetPassword({
        token: '  abc123  ',
        newPassword: validPassword,
        confirmPassword: validPassword,
      }),
      { token: 'abc123', newPassword: validPassword },
    );

    assert.deepEqual(
      parseResetPassword({
        token: 'abc123',
        newPassword: validPassword,
        confirmNewPassword: validPassword,
      }),
      { token: 'abc123', newPassword: validPassword },
    );

    assert.deepEqual(
      parseResetPassword({
        token: 'abc123',
        newPassword: validPassword,
        confirmPassword: validPassword,
        confirmNewPassword: validPassword,
      }),
      { token: 'abc123', newPassword: validPassword },
    );
  });

  test('từ chối 400 VALIDATION_ERROR với input không hợp lệ hoặc thừa field lạ mà không đụng DB hay xóa cookie', async () => {
    let txCalled = false;
    stub(prisma, '$transaction', async () => {
      txCalled = true;
      throw new Error('Should not run transaction on validation error');
    });

    const invalidPayloads = [
      {},
      { token: '', newPassword: 'NewPassword@123', confirmNewPassword: 'NewPassword@123' },
      { token: '   ', newPassword: 'NewPassword@123', confirmNewPassword: 'NewPassword@123' },
      { token: 'a'.repeat(257), newPassword: 'NewPassword@123', confirmNewPassword: 'NewPassword@123' },
      { newPassword: 'NewPassword@123', confirmNewPassword: 'NewPassword@123' },
      { token: 'valid-token', newPassword: 'NewPassword@123' },
      {
        token: 'valid-token',
        newPassword: 'NewPassword@123',
        confirmPassword: 'NewPassword@123',
        confirmNewPassword: 'OtherPassword@123',
      },
      { token: 'valid-token', newPassword: 'NewPassword@123', confirmPassword: 'Different@123' },
      { token: 'valid-token', newPassword: 'NewPassword@123', confirmNewPassword: 'Different@123' },
      { token: 'valid-token', newPassword: 'weak', confirmNewPassword: 'weak' },
      { token: 'valid-token', newPassword: 'lowercase1!', confirmNewPassword: 'lowercase1!' },
      { token: 'valid-token', newPassword: 'UPPERCASE1!', confirmNewPassword: 'UPPERCASE1!' },
      { token: 'valid-token', newPassword: 'NoDigitsHere!', confirmNewPassword: 'NoDigitsHere!' },
      { token: 'valid-token', newPassword: 'NoSpecial123', confirmNewPassword: 'NoSpecial123' },
      {
        token: 'valid-token',
        newPassword: `Aa1!${'x'.repeat(69)}`,
        confirmNewPassword: `Aa1!${'x'.repeat(69)}`,
      },
      {
        token: 'valid-token',
        newPassword: `Aa1!${'é'.repeat(35)}`,
        confirmNewPassword: `Aa1!${'é'.repeat(35)}`,
      },
      {
        token: 'valid-token',
        newPassword: 'NewPassword@123',
        confirmNewPassword: 'NewPassword@123',
        unexpectedField: true,
      },
    ];

    for (const payload of invalidPayloads) {
      const { response, body } = await sendResetRequest(app, payload);
      assert.equal(response.status, 400);
      assert.equal(body.success, false);
      assert.equal(body.code, 'VALIDATION_ERROR');
      assert.equal(response.headers.get('set-cookie'), null);
    }

    assert.equal(txCalled, false);
  });
});

describe('POST /api/v1/auth/reset-password', () => {
  test('trả 400 INVALID_OR_EXPIRED_RESET_TOKEN và không đổi mật khẩu, không thu hồi phiên, không ghi audit, không xóa cookie khi token không hợp lệ', async () => {
    const scenarios: Array<{
      name: string;
      record: any;
      updateManyCount?: number;
    }> = [
      { name: 'missing token in DB', record: null },
      {
        name: 'already-used token',
        record: {
          id: 'token-used',
          userId: '550e8400-e29b-41d4-a716-446655440011',
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          usedAt: new Date(Date.now() - 1000),
          user: { id: '550e8400-e29b-41d4-a716-446655440011', accountStatus: 'ACTIVE' },
        },
      },
      {
        name: 'expired token',
        record: {
          id: 'token-expired',
          userId: '550e8400-e29b-41d4-a716-446655440012',
          expiresAt: new Date(Date.now() - 1000),
          usedAt: null,
          user: { id: '550e8400-e29b-41d4-a716-446655440012', accountStatus: 'ACTIVE' },
        },
      },
      {
        name: 'LOCKED user',
        record: {
          id: 'token-locked',
          userId: '550e8400-e29b-41d4-a716-446655440013',
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          usedAt: null,
          user: { id: '550e8400-e29b-41d4-a716-446655440013', accountStatus: 'LOCKED' },
        },
      },
      {
        name: 'INACTIVE user',
        record: {
          id: 'token-inactive',
          userId: '550e8400-e29b-41d4-a716-446655440014',
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          usedAt: null,
          user: { id: '550e8400-e29b-41d4-a716-446655440014', accountStatus: 'INACTIVE' },
        },
      },
      {
        name: 'concurrent updateMany count === 0',
        record: {
          id: 'token-raced',
          userId: '550e8400-e29b-41d4-a716-446655440015',
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          usedAt: null,
          user: { id: '550e8400-e29b-41d4-a716-446655440015', accountStatus: 'ACTIVE' },
        },
        updateManyCount: 0,
      },
    ];

    for (const scenario of scenarios) {
      let userUpdated = false;
      let sessionRevoked = false;
      let auditCreated = false;

      stub(prisma, '$transaction', async (run: any) => run(prisma));
      stub((prisma as any).passwordResetToken, 'findUnique', async () => scenario.record);
      stub((prisma as any).passwordResetToken, 'updateMany', async () => ({
        count: scenario.updateManyCount ?? 0,
      }));
      stub(prisma.user, 'update', async () => {
        userUpdated = true;
        throw new Error(`Unexpected user.update for ${scenario.name}`);
      });
      stub((prisma as any).refreshSession, 'updateMany', async () => {
        sessionRevoked = true;
        throw new Error(`Unexpected refreshSession.updateMany for ${scenario.name}`);
      });
      stub((prisma as any).auditLog, 'create', async () => {
        auditCreated = true;
        throw new Error(`Unexpected auditLog.create for ${scenario.name}`);
      });

      const { response, body } = await sendResetRequest(app, {
        token: 'a'.repeat(64),
        newPassword: 'NewPassword@123',
        confirmNewPassword: 'NewPassword@123',
      });

      assert.equal(response.status, 400, scenario.name);
      assert.equal(body.success, false, scenario.name);
      assert.equal(body.code, 'INVALID_OR_EXPIRED_RESET_TOKEN', scenario.name);
      assert.equal(body.message, 'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn', scenario.name);
      assert.equal(response.headers.get('set-cookie'), null, scenario.name);
      assert.equal(userUpdated, false, scenario.name);
      assert.equal(sessionRevoked, false, scenario.name);
      assert.equal(auditCreated, false, scenario.name);
    }
  });

  test('happy path: hash SHA-256 token, bcrypt 12 rounds, tiêu thụ token, thu hồi refresh sessions, ghi audit log không lộ bí mật và xóa cookie', async () => {
    const { rawToken, tokenHash } = newPasswordResetToken();
    const userId = '550e8400-e29b-41d4-a716-446655440099';
    const resetTokenId = '550e8400-e29b-41d4-a716-446655440199';
    const newPassword = 'NewStrongPassword@2026';

    let findUniqueArgs: any;
    let consumeArgs: any;
    let userUpdateArgs: any;
    let refreshUpdateArgs: any;
    let auditCreateArgs: any;

    stub(prisma, '$transaction', async (run: any) => run(prisma));
    stub((prisma as any).passwordResetToken, 'findUnique', async (args: any) => {
      findUniqueArgs = args;
      return {
        id: resetTokenId,
        userId,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        usedAt: null,
        user: {
          id: userId,
          accountStatus: 'ACTIVE',
        },
      };
    });
    stub((prisma as any).passwordResetToken, 'updateMany', async (args: any) => {
      consumeArgs = args;
      return { count: 1 };
    });
    stub(prisma.user, 'update', async (args: any) => {
      userUpdateArgs = args;
      return { id: userId };
    });
    stub((prisma as any).refreshSession, 'updateMany', async (args: any) => {
      refreshUpdateArgs = args;
      return { count: 2 };
    });
    stub((prisma as any).auditLog, 'create', async (args: any) => {
      auditCreateArgs = args;
      return { id: 'audit-1', ...args.data };
    });

    const { response, body, text } = await sendResetRequest(app, {
      token: `  ${rawToken}  `,
      newPassword,
      confirmPassword: newPassword,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      success: true,
      message: 'Đặt lại mật khẩu thành công. Vui lòng đăng nhập lại.',
    });

    assert.deepEqual(findUniqueArgs.where, { tokenHash: sha256Hex(rawToken) });
    assert.equal(findUniqueArgs.where.tokenHash, tokenHash);

    assert.equal(consumeArgs.where.id, resetTokenId);
    assert.equal(consumeArgs.where.usedAt, null);
    assert.ok(consumeArgs.where.expiresAt.gt instanceof Date);
    assert.ok(consumeArgs.data.usedAt instanceof Date);

    assert.deepEqual(userUpdateArgs.where, { id: userId });
    assert.equal(bcrypt.getRounds(userUpdateArgs.data.passwordHash), 12);
    assert.equal(await bcrypt.compare(newPassword, userUpdateArgs.data.passwordHash), true);

    assert.deepEqual(refreshUpdateArgs.where, { userId, revokedAt: null });
    assert.ok(refreshUpdateArgs.data.revokedAt instanceof Date);

    assert.equal(auditCreateArgs.data.actorId, userId);
    assert.equal(auditCreateArgs.data.entityType, 'User');
    assert.equal(auditCreateArgs.data.entityId, userId);
    assert.equal(auditCreateArgs.data.action, 'PASSWORD_RESET_COMPLETED');
    assert.deepEqual(auditCreateArgs.data.newData, {
      sessionsRevoked: true,
      resetTokenId,
    });

    const serializedAudit = JSON.stringify(auditCreateArgs.data);
    assert.equal(serializedAudit.includes(rawToken), false);
    assert.equal(serializedAudit.includes(tokenHash), false);
    assert.equal(serializedAudit.includes(newPassword), false);
    assert.equal(serializedAudit.includes(userUpdateArgs.data.passwordHash), false);

    assert.equal(text.includes(rawToken), false);
    assert.equal(text.includes(tokenHash), false);

    const setCookie = response.headers.get('set-cookie');
    assert.ok(setCookie);
    assert.match(setCookie, /^refreshToken=;/i);
    assert.match(setCookie, /Max-Age=0/i);
    assert.match(setCookie, /Path=\/api\/v1\/auth/i);
    assert.match(setCookie, /HttpOnly/i);
  });
});
