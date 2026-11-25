import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, test } from 'node:test';
import { Prisma } from '@prisma/client';
import bcrypt from 'bcrypt';
import { app } from '../../src/app';
import { ApiError } from '../../src/common/errors/api-error';
import { prisma } from '../../src/infrastructure/database/prisma';
import { signAccessToken } from '../../src/modules/auth/auth.security';
import { BCRYPT_ROUNDS } from '../../src/modules/auth/auth.service';
import { changeMyPassword } from '../../src/modules/users/users.service';
import { validateChangePassword } from '../../src/modules/users/users.validation';

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

const baseUser = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  fullName: 'Nguyen Van A',
  email: 'a@example.com',
  phone: '0901234567',
  role: 'TENANT',
  accountStatus: 'ACTIVE',
};

const CURRENT_PASSWORD = 'OldPassword@123';
const NEW_PASSWORD = 'NewPassword@456';

async function request(path: string, init: RequestInit = {}) {
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

describe('users.validation — validateChangePassword', () => {
  test('accepts valid change password payload and omits confirmNewPassword', () => {
    const parsed = validateChangePassword({
      currentPassword: CURRENT_PASSWORD,
      newPassword: NEW_PASSWORD,
      confirmNewPassword: NEW_PASSWORD,
    });

    assert.deepEqual(parsed, {
      currentPassword: CURRENT_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
  });

  test('enforces exact 72 UTF-8 bytes boundary for ASCII and multi-byte passwords', () => {
    const exact72Ascii = 'Aa1!' + 'x'.repeat(68);
    assert.equal(Buffer.byteLength(exact72Ascii, 'utf8'), 72);
    assert.deepEqual(
      validateChangePassword({
        currentPassword: CURRENT_PASSWORD,
        newPassword: exact72Ascii,
        confirmNewPassword: exact72Ascii,
      }),
      {
        currentPassword: CURRENT_PASSWORD,
        newPassword: exact72Ascii,
      },
    );

    const exact72MultiByte = 'Aa1!' + 'é'.repeat(34);
    assert.equal(Buffer.byteLength(exact72MultiByte, 'utf8'), 72);
    assert.deepEqual(
      validateChangePassword({
        currentPassword: CURRENT_PASSWORD,
        newPassword: exact72MultiByte,
        confirmNewPassword: exact72MultiByte,
      }),
      {
        currentPassword: CURRENT_PASSWORD,
        newPassword: exact72MultiByte,
      },
    );

    const over72Ascii = 'Aa1!' + 'x'.repeat(69);
    const over72MultiByte = 'Aa1!' + 'é'.repeat(35);
    for (const badNewPassword of [over72Ascii, over72MultiByte]) {
      assert.throws(
        () =>
          validateChangePassword({
            currentPassword: CURRENT_PASSWORD,
            newPassword: badNewPassword,
            confirmNewPassword: badNewPassword,
          }),
        (err: unknown) =>
          err instanceof ApiError && err.statusCode === 400 && err.code === 'VALIDATION_ERROR',
      );
    }
  });

  test('rejects weak newPassword and >72 UTF-8 byte passwords', () => {
    const invalidPayloads = [
      // too short
      { currentPassword: CURRENT_PASSWORD, newPassword: 'Aa1!', confirmNewPassword: 'Aa1!' },
      // missing uppercase
      { currentPassword: CURRENT_PASSWORD, newPassword: 'password@123', confirmNewPassword: 'password@123' },
      // missing lowercase
      { currentPassword: CURRENT_PASSWORD, newPassword: 'PASSWORD@123', confirmNewPassword: 'PASSWORD@123' },
      // missing digit
      { currentPassword: CURRENT_PASSWORD, newPassword: 'Password@abc', confirmNewPassword: 'Password@abc' },
      // missing special char
      { currentPassword: CURRENT_PASSWORD, newPassword: 'Password1234', confirmNewPassword: 'Password1234' },
      // newPassword > 72 ASCII bytes
      {
        currentPassword: CURRENT_PASSWORD,
        newPassword: 'Aa1!' + 'x'.repeat(69),
        confirmNewPassword: 'Aa1!' + 'x'.repeat(69),
      },
      // newPassword > 72 UTF-8 multi-byte chars
      {
        currentPassword: CURRENT_PASSWORD,
        newPassword: 'Aa1!' + 'é'.repeat(35),
        confirmNewPassword: 'Aa1!' + 'é'.repeat(35),
      },
      // currentPassword > 72 UTF-8 bytes
      {
        currentPassword: 'x'.repeat(73),
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      },
      // empty currentPassword / confirmNewPassword
      { currentPassword: '', newPassword: NEW_PASSWORD, confirmNewPassword: NEW_PASSWORD },
      { currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD, confirmNewPassword: '' },
    ];

    for (const payload of invalidPayloads) {
      assert.throws(
        () => validateChangePassword(payload),
        (err: unknown) =>
          err instanceof ApiError && err.statusCode === 400 && err.code === 'VALIDATION_ERROR',
      );
    }
  });

  test('rejects confirmNewPassword mismatch with errors.confirmNewPassword', () => {
    assert.throws(
      () =>
        validateChangePassword({
          currentPassword: CURRENT_PASSWORD,
          newPassword: NEW_PASSWORD,
          confirmNewPassword: 'DifferentPass@789',
        }),
      (err: unknown) =>
        err instanceof ApiError &&
        err.statusCode === 400 &&
        err.code === 'VALIDATION_ERROR' &&
        Boolean(err.errors?.confirmNewPassword?.length),
    );
  });

  test('rejects newPassword === currentPassword with errors.newPassword', () => {
    assert.throws(
      () =>
        validateChangePassword({
          currentPassword: CURRENT_PASSWORD,
          newPassword: CURRENT_PASSWORD,
          confirmNewPassword: CURRENT_PASSWORD,
        }),
      (err: unknown) =>
        err instanceof ApiError &&
        err.statusCode === 400 &&
        err.code === 'VALIDATION_ERROR' &&
        Boolean(err.errors?.newPassword?.length),
    );
  });

  test('rejects unknown extra fields via .strict() and non-object payloads', () => {
    for (const payload of [
      {
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
        role: 'ADMIN',
      },
      {
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
        extraField: true,
      },
      null,
      undefined,
      [],
      'invalid',
    ]) {
      assert.throws(
        () => validateChangePassword(payload),
        (err: unknown) =>
          err instanceof ApiError && err.statusCode === 400 && err.code === 'VALIDATION_ERROR',
      );
    }
  });
});

describe('users.service — changeMyPassword', () => {
  test('hashes new password with BCRYPT_ROUNDS (12) and mutates inside Serializable transaction with FOR UPDATE', async () => {
    const oldHash = await bcrypt.hash(CURRENT_PASSWORD, 4);
    let capturedHash = '';
    let capturedIsolation = '';
    let lockQueryCalled = false;

    stub(prisma.user, 'findUnique', async (args: any) => {
      assert.equal(args.where.id, baseUser.id);
      return { id: baseUser.id, accountStatus: 'ACTIVE', passwordHash: oldHash };
    });

    const txClient = {
      $queryRaw: async () => {
        lockQueryCalled = true;
        return [{ id: baseUser.id, account_status: 'ACTIVE', password_hash: oldHash }];
      },
      user: {
        update: async (args: any) => {
          assert.equal(args.where.id, baseUser.id);
          capturedHash = args.data.passwordHash;
          return { id: baseUser.id };
        },
      },
      refreshSession: {
        updateMany: async () => ({ count: 1 }),
      },
      auditLog: {
        create: async () => ({ id: 'audit-1' }),
      },
    };
    stub(prisma, '$transaction', async (callback: any, options: any) => {
      capturedIsolation = options?.isolationLevel;
      return callback(txClient);
    });

    const result = await changeMyPassword(baseUser.id, {
      currentPassword: CURRENT_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    assert.deepEqual(result, { message: 'Đổi mật khẩu thành công. Vui lòng đăng nhập lại' });
    assert.equal(capturedIsolation, Prisma.TransactionIsolationLevel.Serializable);
    assert.equal(lockQueryCalled, true);
    assert.equal(BCRYPT_ROUNDS, 12);
    assert.equal(bcrypt.getRounds(capturedHash), 12);
    assert.equal(await bcrypt.compare(NEW_PASSWORD, capturedHash), true);
  });

  test('retries on Prisma P2034 serialization conflict and succeeds on subsequent attempt', async () => {
    const oldHash = await bcrypt.hash(CURRENT_PASSWORD, 4);
    let attempts = 0;

    stub(prisma.user, 'findUnique', async () => ({
      id: baseUser.id,
      accountStatus: 'ACTIVE',
      passwordHash: oldHash,
    }));

    const txClient = {
      $queryRaw: async () => [{ id: baseUser.id, account_status: 'ACTIVE', password_hash: oldHash }],
      user: { update: async () => ({ id: baseUser.id }) },
      refreshSession: { updateMany: async () => ({ count: 1 }) },
      auditLog: { create: async () => ({ id: 'audit-1' }) },
    };

    stub(prisma, '$transaction', async (callback: any, options: any) => {
      assert.equal(options?.isolationLevel, Prisma.TransactionIsolationLevel.Serializable);
      attempts++;
      if (attempts === 1) {
        throw { code: 'P2034' };
      }
      return callback(txClient);
    });

    const result = await changeMyPassword(baseUser.id, {
      currentPassword: CURRENT_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    assert.equal(attempts, 2);
    assert.deepEqual(result, { message: 'Đổi mật khẩu thành công. Vui lòng đăng nhập lại' });
  });

  test('rejects concurrent password change when locked passwordHash differs from pre-check passwordHash without overwriting', async () => {
    const oldHash = await bcrypt.hash(CURRENT_PASSWORD, 4);
    const committedConcurrentHash = await bcrypt.hash('ConcurrentPass@999', 4);
    let userUpdateCalled = false;

    stub(prisma.user, 'findUnique', async () => ({
      id: baseUser.id,
      accountStatus: 'ACTIVE',
      passwordHash: oldHash,
    }));

    const txClient = {
      $queryRaw: async () => [
        {
          id: baseUser.id,
          account_status: 'ACTIVE',
          password_hash: committedConcurrentHash,
        },
      ],
      user: {
        update: async () => {
          userUpdateCalled = true;
          return { id: baseUser.id };
        },
      },
      refreshSession: { updateMany: async () => ({ count: 0 }) },
      auditLog: { create: async () => ({ id: 'audit-1' }) },
    };
    stub(prisma, '$transaction', async (callback: any) => callback(txClient));

    await assert.rejects(
      () =>
        changeMyPassword(baseUser.id, {
          currentPassword: CURRENT_PASSWORD,
          newPassword: NEW_PASSWORD,
        }),
      (err: unknown) =>
        err instanceof ApiError &&
        err.statusCode === 400 &&
        err.code === 'INVALID_CURRENT_PASSWORD',
    );
    assert.equal(userUpdateCalled, false);
  });

  test('throws 400 INVALID_CURRENT_PASSWORD when currentPassword does not match', async () => {
    const oldHash = await bcrypt.hash(CURRENT_PASSWORD, 4);
    let txCalled = false;

    stub(prisma.user, 'findUnique', async () => ({
      id: baseUser.id,
      accountStatus: 'ACTIVE',
      passwordHash: oldHash,
    }));
    stub(prisma, '$transaction', async () => {
      txCalled = true;
    });

    await assert.rejects(
      () =>
        changeMyPassword(baseUser.id, {
          currentPassword: 'WrongPassword@123',
          newPassword: NEW_PASSWORD,
        }),
      (err: unknown) =>
        err instanceof ApiError &&
        err.statusCode === 400 &&
        err.code === 'INVALID_CURRENT_PASSWORD',
    );
    assert.equal(txCalled, false);
  });

  test('direct service call rejects newPassword === currentPassword with 400 VALIDATION_ERROR', async () => {
    const oldHash = await bcrypt.hash(CURRENT_PASSWORD, 4);

    stub(prisma.user, 'findUnique', async () => ({
      id: baseUser.id,
      accountStatus: 'ACTIVE',
      passwordHash: oldHash,
    }));

    await assert.rejects(
      () =>
        changeMyPassword(baseUser.id, {
          currentPassword: CURRENT_PASSWORD,
          newPassword: CURRENT_PASSWORD,
        }),
      (err: unknown) =>
        err instanceof ApiError &&
        err.statusCode === 400 &&
        err.code === 'VALIDATION_ERROR' &&
        Boolean(err.errors?.newPassword?.length),
    );
  });

  test('maps missing user to 401 UNAUTHORIZED, inactive user to 403 ACCOUNT_LOCKED, and P2025 to 401 UNAUTHORIZED', async () => {
    stub(prisma.user, 'findUnique', async () => null);
    await assert.rejects(
      () => changeMyPassword(baseUser.id, { currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD }),
      (err: unknown) =>
        err instanceof ApiError && err.statusCode === 401 && err.code === 'UNAUTHORIZED',
    );

    stub(prisma.user, 'findUnique', async () => ({
      id: baseUser.id,
      accountStatus: 'LOCKED',
      passwordHash: 'hash',
    }));
    await assert.rejects(
      () => changeMyPassword(baseUser.id, { currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD }),
      (err: unknown) =>
        err instanceof ApiError && err.statusCode === 403 && err.code === 'ACCOUNT_LOCKED',
    );

    const oldHash = await bcrypt.hash(CURRENT_PASSWORD, 4);
    stub(prisma.user, 'findUnique', async () => ({
      id: baseUser.id,
      accountStatus: 'ACTIVE',
      passwordHash: oldHash,
    }));
    stub(prisma, '$transaction', async () => {
      throw { code: 'P2025' };
    });
    await assert.rejects(
      () => changeMyPassword(baseUser.id, { currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD }),
      (err: unknown) =>
        err instanceof ApiError && err.statusCode === 401 && err.code === 'UNAUTHORIZED',
    );
  });
});

describe('HTTP PATCH /api/v1/users/me/password', () => {
  test('happy path: updates passwordHash, revokes refresh sessions, records audit log without secrets, clears refresh cookie, and returns 200', async () => {
    const oldHash = await bcrypt.hash(CURRENT_PASSWORD, 4);
    let updatedPasswordHash = '';
    let revokedWhere: any;
    let revokedData: any;
    let auditCreatedData: any;

    stub(prisma.user, 'findUnique', async (args: any) => {
      if (args?.select?.passwordHash) {
        return { id: baseUser.id, accountStatus: 'ACTIVE', passwordHash: oldHash };
      }
      return baseUser;
    });

    const txClient = {
      $queryRaw: async () => [{ id: baseUser.id, account_status: 'ACTIVE', password_hash: oldHash }],
      user: {
        update: async (args: any) => {
          assert.equal(args.where.id, baseUser.id);
          updatedPasswordHash = args.data.passwordHash;
          return { id: baseUser.id };
        },
      },
      refreshSession: {
        updateMany: async (args: any) => {
          revokedWhere = args.where;
          revokedData = args.data;
          return { count: 2 };
        },
      },
      auditLog: {
        create: async (args: any) => {
          auditCreatedData = args.data;
          return { id: 'audit-1', ...args.data };
        },
      },
    };

    stub(prisma, '$transaction', async (callback: any, options: any) => {
      assert.equal(options?.isolationLevel, Prisma.TransactionIsolationLevel.Serializable);
      return callback(txClient);
    });

    const { response, body } = await request('/api/v1/users/me/password', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
      },
      body: JSON.stringify({
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      message: 'Đổi mật khẩu thành công. Vui lòng đăng nhập lại',
    });

    const setCookie = response.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /^refreshToken=;/i);
    assert.match(setCookie, /Max-Age=0/i);
    assert.match(setCookie, /Path=\/api\/v1\/auth/i);
    assert.match(setCookie, /HttpOnly/i);

    assert.equal(bcrypt.getRounds(updatedPasswordHash), 12);
    assert.equal(await bcrypt.compare(NEW_PASSWORD, updatedPasswordHash), true);

    assert.deepEqual(revokedWhere, { userId: baseUser.id, revokedAt: null });
    assert.ok(revokedData.revokedAt instanceof Date);

    assert.equal(auditCreatedData.actorId, baseUser.id);
    assert.equal(auditCreatedData.entityType, 'User');
    assert.equal(auditCreatedData.entityId, baseUser.id);
    assert.equal(auditCreatedData.action, 'PASSWORD_CHANGED');
    assert.equal(auditCreatedData.oldData, Prisma.JsonNull);
    assert.deepEqual(auditCreatedData.newData, { sessionsRevoked: true });

    const serializedAudit = JSON.stringify(auditCreatedData);
    assert.equal(serializedAudit.includes(CURRENT_PASSWORD), false);
    assert.equal(serializedAudit.includes(NEW_PASSWORD), false);
    assert.equal(serializedAudit.includes(oldHash), false);
    assert.equal(serializedAudit.includes(updatedPasswordHash), false);
  });

  test('transaction failure returns 500 and does NOT clear refreshToken cookie', async () => {
    const oldHash = await bcrypt.hash(CURRENT_PASSWORD, 4);

    stub(prisma.user, 'findUnique', async (args: any) => {
      if (args?.select?.passwordHash) {
        return { id: baseUser.id, accountStatus: 'ACTIVE', passwordHash: oldHash };
      }
      return baseUser;
    });
    stub(prisma, '$transaction', async () => {
      throw new Error('database unavailable');
    });

    const { response, body } = await request('/api/v1/users/me/password', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
      },
      body: JSON.stringify({
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      }),
    });

    assert.equal(response.status, 500);
    assert.equal(body.code, 'INTERNAL_ERROR');
    assert.equal(response.headers.get('set-cookie'), null);
  });

  test('wrong currentPassword returns 400 INVALID_CURRENT_PASSWORD without updating DB or clearing cookie', async () => {
    const oldHash = await bcrypt.hash(CURRENT_PASSWORD, 4);
    let transactionCalled = false;

    stub(prisma.user, 'findUnique', async (args: any) => {
      if (args?.select?.passwordHash) {
        return { id: baseUser.id, accountStatus: 'ACTIVE', passwordHash: oldHash };
      }
      return baseUser;
    });
    stub(prisma, '$transaction', async () => {
      transactionCalled = true;
    });

    const { response, body } = await request('/api/v1/users/me/password', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
      },
      body: JSON.stringify({
        currentPassword: 'WrongPassword@123',
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(body.success, false);
    assert.equal(body.code, 'INVALID_CURRENT_PASSWORD');
    assert.equal(transactionCalled, false);
    assert.equal(response.headers.get('set-cookie'), null);
  });

  test('validation failures return 400 VALIDATION_ERROR without DB writes or clearing cookie', async () => {
    let transactionCalled = false;

    stub(prisma.user, 'findUnique', async () => baseUser);
    stub(prisma, '$transaction', async () => {
      transactionCalled = true;
    });

    const invalidBodies = [
      { currentPassword: CURRENT_PASSWORD, newPassword: 'weak', confirmNewPassword: 'weak' },
      {
        currentPassword: CURRENT_PASSWORD,
        newPassword: 'Aa1!' + 'x'.repeat(69),
        confirmNewPassword: 'Aa1!' + 'x'.repeat(69),
      },
      {
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: 'MismatchPassword@789',
      },
      {
        currentPassword: CURRENT_PASSWORD,
        newPassword: CURRENT_PASSWORD,
        confirmNewPassword: CURRENT_PASSWORD,
      },
      {
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
        unknownField: 'unexpected',
      },
    ];

    for (const payload of invalidBodies) {
      const { response, body } = await request('/api/v1/users/me/password', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
        },
        body: JSON.stringify(payload),
      });

      assert.equal(response.status, 400);
      assert.equal(body.success, false);
      assert.equal(body.code, 'VALIDATION_ERROR');
      assert.equal(response.headers.get('set-cookie'), null);
    }

    assert.equal(transactionCalled, false);
  });

  test('returns 401 UNAUTHORIZED without token or when user is missing/deleted', async () => {
    const noAuth = await request('/api/v1/users/me/password', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      }),
    });
    assert.equal(noAuth.response.status, 401);
    assert.equal(noAuth.body.code, 'UNAUTHORIZED');

    stub(prisma.user, 'findUnique', async () => null);
    const missingUser = await request('/api/v1/users/me/password', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
      },
      body: JSON.stringify({
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      }),
    });
    assert.equal(missingUser.response.status, 401);
    assert.equal(missingUser.body.code, 'UNAUTHORIZED');
  });

  test('returns 403 ACCOUNT_LOCKED when user is locked or inactive', async () => {
    for (const status of ['LOCKED', 'INACTIVE']) {
      stub(prisma.user, 'findUnique', async () => ({
        ...baseUser,
        accountStatus: status,
      }));

      const { response, body } = await request('/api/v1/users/me/password', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
        },
        body: JSON.stringify({
          currentPassword: CURRENT_PASSWORD,
          newPassword: NEW_PASSWORD,
          confirmNewPassword: NEW_PASSWORD,
        }),
      });

      assert.equal(response.status, 403);
      assert.equal(body.code, 'ACCOUNT_LOCKED');
    }
  });
});
