import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, test } from 'node:test';
import { app } from '../../src/app';
import { ApiError } from '../../src/common/errors/api-error';
import { prisma } from '../../src/infrastructure/database/prisma';
import { signAccessToken } from '../../src/modules/auth/auth.security';
import { UsersRepository } from '../../src/modules/users/users.repository';
import { getCurrentUser, updateCurrentUser } from '../../src/modules/users/users.service';
import {
  validateDateOfBirthString,
  validateUpdateUserProfile,
} from '../../src/modules/users/users.validation';

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

function formatDateYmd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function getUtcDateOffsetYears(yearsOffset: number, daysOffset: number = 0): string {
  const now = new Date();
  const target = new Date(
    Date.UTC(
      now.getUTCFullYear() + yearsOffset,
      now.getUTCMonth(),
      now.getUTCDate() + daysOffset,
    ),
  );
  return target.toISOString().slice(0, 10);
}

const baseUser = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  fullName: 'Nguyen Van A',
  email: 'a@example.com',
  phone: '0901234567',
  role: 'TENANT',
  accountStatus: 'ACTIVE',
  avatarUrl: 'https://res.cloudinary.com/demo/image/upload/v1/rentmate/avatars/user-1.webp',
  dateOfBirth: new Date('2000-05-15T00:00:00.000Z'),
  address: 'KTX Khu B ĐHQG, TP. Thủ Đức',
};

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

describe('users.validation — validateDateOfBirthString & validateUpdateUserProfile', () => {
  test('accepts valid partial updates and trims string fields', () => {
    const onlyName = validateUpdateUserProfile({ fullName: '  Trần Thị B  ' });
    assert.deepEqual(onlyName, { fullName: 'Trần Thị B' });

    const onlyPhone = validateUpdateUserProfile({ phone: ' 0987654321 ' });
    assert.deepEqual(onlyPhone, { phone: '0987654321' });

    const onlyAddress = validateUpdateUserProfile({ address: '  123 Lê Lợi, Q1  ' });
    assert.deepEqual(onlyAddress, { address: '123 Lê Lợi, Q1' });

    const onlyDob = validateUpdateUserProfile({ dateOfBirth: ' 1999-12-31 ' });
    assert.ok(onlyDob.dateOfBirth instanceof Date);
    assert.equal(onlyDob.dateOfBirth.toISOString(), '1999-12-31T00:00:00.000Z');
  });

  test('allows null for dateOfBirth and address to clear fields', () => {
    const parsed = validateUpdateUserProfile({ dateOfBirth: null, address: null });
    assert.deepEqual(parsed, { dateOfBirth: null, address: null });
  });

  test('rejects null for fullName and phone', () => {
    assert.throws(
      () => validateUpdateUserProfile({ fullName: null }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert.ok(err.errors?.fullName);
        return true;
      },
    );

    assert.throws(
      () => validateUpdateUserProfile({ phone: null }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert.ok(err.errors?.phone);
        return true;
      },
    );
  });

  test('rejects invalid fullName, phone, and address values', () => {
    for (const payload of [
      { fullName: 'A' },
      { fullName: '  A  ' },
      { fullName: 'x'.repeat(151) },
      { phone: '090123456' },
      { phone: '1901234567' },
      { phone: '+84901234567' },
      { phone: '090123456a' },
      { address: '' },
      { address: '   ' },
      { address: 'a'.repeat(501) },
    ]) {
      assert.throws(
        () => validateUpdateUserProfile(payload),
        (err: unknown) => err instanceof ApiError && err.statusCode === 400 && err.code === 'VALIDATION_ERROR',
      );
    }
  });

  test('rejects empty object {} and non-object payloads', () => {
    for (const payload of [{}, null, undefined, [], 'text']) {
      assert.throws(
        () => validateUpdateUserProfile(payload),
        (err: unknown) => err instanceof ApiError && err.statusCode === 400 && err.code === 'VALIDATION_ERROR',
      );
    }
  });

  test('rejects unknown and forbidden fields via .strict()', () => {
    for (const payload of [
      { fullName: 'Nguyen Van A', email: 'hack@example.com' },
      { fullName: 'Nguyen Van A', role: 'ADMIN' },
      { fullName: 'Nguyen Van A', accountStatus: 'LOCKED' },
      { fullName: 'Nguyen Van A', passwordHash: 'hash' },
      { fullName: 'Nguyen Van A', id: '550e8400-e29b-41d4-a716-446655440000' },
      { fullName: 'Nguyen Van A', avatarUrl: 'https://example.com/a.png' },
      { fullName: 'Nguyen Van A', unknownField: true },
    ]) {
      assert.throws(
        () => validateUpdateUserProfile(payload),
        (err: unknown) => err instanceof ApiError && err.statusCode === 400 && err.code === 'VALIDATION_ERROR',
      );
    }
  });

  test('validates dateOfBirth calendar dates, >= 1900-01-01, and >= 16 years old (UTC-safe)', () => {
    // Valid boundaries
    assert.equal(validateDateOfBirthString('1900-01-01', new Date('2026-11-23T12:00:00Z')).valid, true);
    assert.equal(validateDateOfBirthString('2004-02-29', new Date('2026-11-23T12:00:00Z')).valid, true);

    // Exact 16-year boundary (UTC-safe, including leap year Feb 29)
    assert.equal(validateDateOfBirthString('2008-02-29', new Date('2024-02-29T00:00:00Z')).valid, true);
    assert.equal(validateDateOfBirthString('2008-02-29', new Date('2024-02-28T23:59:59Z')).valid, false);
    assert.equal(validateDateOfBirthString('2010-11-23', new Date('2026-11-23T00:00:00Z')).valid, true);
    assert.equal(validateDateOfBirthString('2010-11-24', new Date('2026-11-23T23:59:59Z')).valid, false);

    // Dynamic UTC today boundary via validateUpdateUserProfile
    const exact16 = getUtcDateOffsetYears(-16, 0);
    const oneDayTooYoung = getUtcDateOffsetYears(-16, 1);
    assert.ok(validateUpdateUserProfile({ dateOfBirth: exact16 }).dateOfBirth instanceof Date);
    assert.throws(
      () => validateUpdateUserProfile({ dateOfBirth: oneDayTooYoung }),
      (err: unknown) => err instanceof ApiError && err.statusCode === 400 && Boolean(err.errors?.dateOfBirth),
    );

    // Invalid calendar dates, before 1900, future, and non-YYYY-MM-DD formats
    for (const badDob of [
      '1899-12-31',
      '2020-02-30',
      '2021-02-29',
      '2020-04-31',
      '2020-13-01',
      '2020-00-10',
      '2099-01-01',
      '2000-05-15T00:00:00Z',
      '15/05/2000',
      formatDateYmd(2025, 1, 1),
    ]) {
      assert.throws(
        () => validateUpdateUserProfile({ dateOfBirth: badDob }),
        (err: unknown) => err instanceof ApiError && err.statusCode === 400 && Boolean(err.errors?.dateOfBirth),
      );
    }
  });
});

describe('users.service — getCurrentUser & updateCurrentUser', () => {
  test('getCurrentUser formats profile fields and never leaks passwordHash or avatarCloudinaryPublicId', async () => {
    stub(UsersRepository, 'findProfileById', async () => ({
      ...baseUser,
      passwordHash: 'secret-hash',
      avatarCloudinaryPublicId: 'rentmate/avatars/secret',
    } as any));

    const profile = await getCurrentUser(baseUser.id);
    assert.deepEqual(profile, {
      userId: baseUser.id,
      fullName: baseUser.fullName,
      email: baseUser.email,
      phone: baseUser.phone,
      role: baseUser.role,
      status: baseUser.accountStatus,
      avatarUrl: baseUser.avatarUrl,
      dateOfBirth: '2000-05-15',
      address: baseUser.address,
    });
    assert.equal('passwordHash' in profile, false);
    assert.equal('avatarCloudinaryPublicId' in profile, false);
  });

  test('updateCurrentUser maps Prisma P2002 on phone to 409 PHONE_ALREADY_EXISTS', async () => {
    const txClient = {
      $queryRaw: async () => [{ id: baseUser.id, account_status: 'ACTIVE' }],
      user: {
        update: async () => {
          throw { code: 'P2002', meta: { target: ['phone'] } };
        },
      },
    };
    stub(prisma, '$transaction', async (callback: any) => callback(txClient));

    await assert.rejects(
      () => updateCurrentUser(baseUser.id, { phone: '0999888777' }),
      (err: unknown) =>
        err instanceof ApiError && err.statusCode === 409 && err.code === 'PHONE_ALREADY_EXISTS',
    );
  });

  test('updateCurrentUser rejects LOCKED account inside FOR UPDATE transaction without calling tx.user.update', async () => {
    let updateCalled = false;
    const txClient = {
      $queryRaw: async () => [{ id: baseUser.id, account_status: 'LOCKED' }],
      user: {
        update: async () => {
          updateCalled = true;
          return baseUser;
        },
      },
    };
    stub(prisma, '$transaction', async (callback: any) => callback(txClient));

    await assert.rejects(
      () => updateCurrentUser(baseUser.id, { fullName: 'Nguyen Van B' }),
      (err: unknown) =>
        err instanceof ApiError && err.statusCode === 403 && err.code === 'ACCOUNT_LOCKED',
    );
    assert.equal(updateCalled, false);
  });
});

describe('HTTP GET /api/v1/users/me & PUT /api/v1/users/me', () => {
  test('GET /api/v1/users/me returns 401 without token', async () => {
    const { response, body } = await request('/api/v1/users/me');
    assert.equal(response.status, 401);
    assert.equal(body.code, 'UNAUTHORIZED');
  });

  test('GET /api/v1/users/me returns 403 ACCOUNT_LOCKED when user is locked', async () => {
    stub(prisma.user, 'findUnique', async () => ({ ...baseUser, accountStatus: 'LOCKED' }));
    const { response, body } = await request('/api/v1/users/me', {
      headers: { Authorization: `Bearer ${signAccessToken(baseUser.id)}` },
    });
    assert.equal(response.status, 403);
    assert.equal(body.code, 'ACCOUNT_LOCKED');
  });

  test('GET /api/v1/users/me returns backward-compatible 6 fields plus profile fields and hides sensitive columns', async () => {
    stub(prisma.user, 'findUnique', async (args: any) => {
      // Ensure repository select never requests passwordHash or avatarCloudinaryPublicId
      if (args?.select) {
        assert.equal('passwordHash' in args.select, false);
        assert.equal('avatarCloudinaryPublicId' in args.select, false);
      }
      return {
        ...baseUser,
        passwordHash: 'must-not-leak',
        avatarCloudinaryPublicId: 'must-not-leak-public-id',
      };
    });

    const { response, body } = await request('/api/v1/users/me', {
      headers: { Authorization: `Bearer ${signAccessToken(baseUser.id)}` },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      userId: baseUser.id,
      fullName: baseUser.fullName,
      email: baseUser.email,
      phone: baseUser.phone,
      role: baseUser.role,
      status: baseUser.accountStatus,
      avatarUrl: baseUser.avatarUrl,
      dateOfBirth: '2000-05-15',
      address: baseUser.address,
    });
    assert.equal('passwordHash' in body, false);
    assert.equal('avatarCloudinaryPublicId' in body, false);
  });

  test('GET /api/v1/users/me defaults omitted optional profile fields to null', async () => {
    stub(prisma.user, 'findUnique', async () => ({
      id: baseUser.id,
      fullName: baseUser.fullName,
      email: baseUser.email,
      phone: baseUser.phone,
      role: baseUser.role,
      accountStatus: baseUser.accountStatus,
    }));

    const { response, body } = await request('/api/v1/users/me', {
      headers: { Authorization: `Bearer ${signAccessToken(baseUser.id)}` },
    });

    assert.equal(response.status, 200);
    assert.equal(body.avatarUrl, null);
    assert.equal(body.dateOfBirth, null);
    assert.equal(body.address, null);
  });

  test('PUT /api/v1/users/me returns 401 without token and 403 when locked', async () => {
    const unauth = await request('/api/v1/users/me', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName: 'Nguyen Van B' }),
    });
    assert.equal(unauth.response.status, 401);
    assert.equal(unauth.body.code, 'UNAUTHORIZED');

    stub(prisma.user, 'findUnique', async () => ({ ...baseUser, accountStatus: 'LOCKED' }));
    const locked = await request('/api/v1/users/me', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
      },
      body: JSON.stringify({ fullName: 'Nguyen Van B' }),
    });
    assert.equal(locked.response.status, 403);
    assert.equal(locked.body.code, 'ACCOUNT_LOCKED');
  });

  test('PUT /api/v1/users/me returns 403 ACCOUNT_LOCKED on TOCTOU lock inside transaction without calling tx.user.update', async () => {
    let updateCalled = false;
    stub(prisma.user, 'findUnique', async () => baseUser);

    const txClient = {
      $queryRaw: async () => [{ id: baseUser.id, account_status: 'LOCKED' }],
      user: {
        update: async () => {
          updateCalled = true;
          return baseUser;
        },
      },
    };
    stub(prisma, '$transaction', async (callback: any) => callback(txClient));

    const { response, body } = await request('/api/v1/users/me', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
      },
      body: JSON.stringify({ fullName: 'Nguyen Van B' }),
    });

    assert.equal(response.status, 403);
    assert.equal(body.code, 'ACCOUNT_LOCKED');
    assert.equal(updateCalled, false);
  });

  test('PUT /api/v1/users/me performs partial update inside transaction and returns 200 flat user DTO', async () => {
    let capturedUpdateData: any;
    stub(prisma.user, 'findUnique', async () => baseUser);

    const txClient = {
      $queryRaw: async () => [{ id: baseUser.id, account_status: 'ACTIVE' }],
      user: {
        update: async (args: any) => {
          capturedUpdateData = args.data;
          assert.equal('passwordHash' in args.select, false);
          assert.equal('avatarCloudinaryPublicId' in args.select, false);
          return {
            ...baseUser,
            ...args.data,
          };
        },
      },
    };
    stub(prisma, '$transaction', async (callback: any) => callback(txClient));

    const { response, body } = await request('/api/v1/users/me', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
      },
      body: JSON.stringify({
        fullName: '  Nguyễn Văn B  ',
        dateOfBirth: '1999-03-20',
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(capturedUpdateData.fullName, 'Nguyễn Văn B');
    assert.ok(capturedUpdateData.dateOfBirth instanceof Date);
    assert.equal(capturedUpdateData.dateOfBirth.toISOString(), '1999-03-20T00:00:00.000Z');
    assert.equal('phone' in capturedUpdateData, false);
    assert.equal('address' in capturedUpdateData, false);

    assert.deepEqual(body, {
      userId: baseUser.id,
      fullName: 'Nguyễn Văn B',
      email: baseUser.email,
      phone: baseUser.phone,
      role: baseUser.role,
      status: baseUser.accountStatus,
      avatarUrl: baseUser.avatarUrl,
      dateOfBirth: '1999-03-20',
      address: baseUser.address,
    });
  });

  test('PUT /api/v1/users/me clears dateOfBirth and address when null is passed', async () => {
    let capturedUpdateData: any;
    stub(prisma.user, 'findUnique', async () => baseUser);

    const txClient = {
      $queryRaw: async () => [{ id: baseUser.id, account_status: 'ACTIVE' }],
      user: {
        update: async (args: any) => {
          capturedUpdateData = args.data;
          return {
            ...baseUser,
            ...args.data,
          };
        },
      },
    };
    stub(prisma, '$transaction', async (callback: any) => callback(txClient));

    const { response, body } = await request('/api/v1/users/me', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
      },
      body: JSON.stringify({
        dateOfBirth: null,
        address: null,
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(capturedUpdateData.dateOfBirth, null);
    assert.equal(capturedUpdateData.address, null);
    assert.equal(body.dateOfBirth, null);
    assert.equal(body.address, null);
  });

  test('PUT /api/v1/users/me rejects invalid inputs and forbidden fields with 400 VALIDATION_ERROR', async () => {
    stub(prisma.user, 'findUnique', async () => baseUser);
    let txCalled = false;
    stub(prisma, '$transaction', async () => {
      txCalled = true;
      return baseUser;
    });

    for (const invalidBody of [
      {},
      { fullName: null },
      { phone: null },
      { dateOfBirth: '2020-02-30' },
      { dateOfBirth: '1899-12-31' },
      { dateOfBirth: getUtcDateOffsetYears(-16, 1) },
      { address: '   ' },
      { fullName: 'Valid Name', role: 'ADMIN' },
      { fullName: 'Valid Name', email: 'other@example.com' },
    ]) {
      const { response, body } = await request('/api/v1/users/me', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
        },
        body: JSON.stringify(invalidBody),
      });

      assert.equal(response.status, 400);
      assert.equal(body.success, false);
      assert.equal(body.code, 'VALIDATION_ERROR');
    }

    assert.equal(txCalled, false);
  });

  test('PUT /api/v1/users/me returns 409 PHONE_ALREADY_EXISTS on duplicate phone race', async () => {
    stub(prisma.user, 'findUnique', async () => baseUser);

    const txClient = {
      $queryRaw: async () => [{ id: baseUser.id, account_status: 'ACTIVE' }],
      user: {
        update: async () => {
          throw { code: 'P2002', meta: { target: ['phone'] } };
        },
      },
    };
    stub(prisma, '$transaction', async (callback: any) => callback(txClient));

    const { response, body } = await request('/api/v1/users/me', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${signAccessToken(baseUser.id)}`,
      },
      body: JSON.stringify({ phone: '0911222333' }),
    });

    assert.equal(response.status, 409);
    assert.equal(body.success, false);
    assert.equal(body.code, 'PHONE_ALREADY_EXISTS');
  });
});
