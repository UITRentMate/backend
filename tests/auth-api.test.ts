import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { afterEach, test } from 'node:test';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { app } from '../src/app';
import { prisma } from '../src/infrastructure/database/prisma';
import { signAccessToken } from '../src/modules/auth/auth.security';

process.env.JWT_SECRET = 'test-secret-must-have-at-least-thirty-two-bytes';
const undo: Array<() => void> = [];
afterEach(() => { while (undo.length) undo.pop()!(); });

function stub(delegate: any, name: string, implementation: (...args: any[]) => any) {
  const original = delegate[name];
  delegate[name] = implementation;
  undo.push(() => { delegate[name] = original; });
}

const user = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  fullName: 'Nguyen Van A',
  email: 'a@example.com',
  phone: '0901234567',
  passwordHash: '',
  role: 'TENANT',
  accountStatus: 'ACTIVE',
  createdAt: new Date(),
  updatedAt: new Date(),
};

async function request(path: string, init: RequestInit = {}) {
  const server = app.listen(0);
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const text = await response.text();
    const body = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : {};
    return { response, body };
  } finally {
    server.close();
  }
}

test('register rejects invalid input', async () => {
  const { response, body } = await request('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fullName: '', email: 'bad', phone: '123', password: 'weak', confirmPassword: 'different', acceptedTerms: false }),
  });
  assert.equal(response.status, 400);
  assert.equal(body.code, 'VALIDATION_ERROR');
  assert.ok(body.errors.email);
});

test('login rejects missing credentials', async () => {
  const { response, body } = await request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: '', password: '' }),
  });
  assert.equal(response.status, 400);
  assert.equal(body.code, 'VALIDATION_ERROR');
});

test('me requires an access token', async () => {
  const { response, body } = await request('/api/v1/users/me');
  assert.equal(response.status, 401);
  assert.equal(body.code, 'UNAUTHORIZED');
});

test('register stores a bcrypt hash and returns only public user fields', async () => {
  let stored: any;
  stub(prisma.user, 'create', async ({ data }: any) => {
    stored = data;
    return { ...user, ...data };
  });
  const { response, body } = await request('/api/v1/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fullName: user.fullName, email: user.email, phone: user.phone, password: 'Password@123', confirmPassword: 'Password@123', acceptedTerms: true }),
  });
  assert.equal(response.status, 201);
  assert.equal(body.role, 'TENANT');
  assert.equal(body.status, 'ACTIVE');
  assert.equal(body.userId, user.id);
  assert.equal('passwordHash' in body, false);
  assert.equal(await bcrypt.compare('Password@123', stored.passwordHash), true);
});

test('register maps database email uniqueness race to 409', async () => {
  stub(prisma.user, 'create', async () => { throw { code: 'P2002', meta: { target: ['email'] } }; });
  const { response, body } = await request('/api/v1/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fullName: user.fullName, email: user.email, phone: user.phone, password: 'Password@123', confirmPassword: 'Password@123', acceptedTerms: true }),
  });
  assert.equal(response.status, 409);
  assert.equal(body.code, 'EMAIL_ALREADY_EXISTS');
});

test('register maps database phone uniqueness race to 409', async () => {
  stub(prisma.user, 'create', async () => { throw { code: 'P2002', meta: { target: ['phone'] } }; });
  const { response, body } = await request('/api/v1/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fullName: user.fullName, email: user.email, phone: user.phone, password: 'Password@123', confirmPassword: 'Password@123', acceptedTerms: true }),
  });
  assert.equal(response.status, 409);
  assert.equal(body.code, 'PHONE_ALREADY_EXISTS');
});

test('login does not reveal whether an account exists', async () => {
  stub(prisma.user, 'findFirst', async () => null);
  const { response, body } = await request('/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'missing@example.com', password: 'Password@123' }),
  });
  assert.equal(response.status, 401);
  assert.equal(body.code, 'INVALID_CREDENTIALS');
  assert.equal(JSON.stringify(body).includes('missing@example.com'), false);
});

test('me returns public fields from the current database row', async () => {
  stub(prisma.user, 'findUnique', async () => user);
  const { response, body } = await request('/api/v1/users/me', {
    headers: { Authorization: `Bearer ${signAccessToken(user.id)}` },
  });
  assert.equal(response.status, 200);
  assert.equal(body.userId, user.id);
  assert.equal(body.status, 'ACTIVE');
  assert.equal('passwordHash' in body, false);
});

test('me rejects a token after its account has been locked', async () => {
  stub(prisma.user, 'findUnique', async () => ({ ...user, accountStatus: 'LOCKED' }));
  const { response, body } = await request('/api/v1/users/me', {
    headers: { Authorization: `Bearer ${signAccessToken(user.id)}` },
  });
  assert.equal(response.status, 403);
  assert.equal(body.code, 'ACCOUNT_LOCKED');
});

test('login returns a one-hour JWT and sets a seven-day HttpOnly refresh cookie', async () => {
  const passwordHash = await bcrypt.hash('Password@123', 4);
  stub(prisma.user, 'findFirst', async () => ({ ...user, passwordHash }));
  let sessionData: any;
  const sessions = (prisma as any).refreshSession;
  assert.ok(sessions, 'Prisma refreshSession delegate required');
  stub(sessions, 'create', async ({ data }: any) => { sessionData = data; return { id: 'session-id', ...data }; });
  const { response, body } = await request('/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user.email, password: 'Password@123' }),
  });
  assert.equal(response.status, 200);
  assert.equal(body.expiresIn, 3600);
  assert.equal('tokenType' in body, false);
  assert.equal('refreshToken' in body, false);
  const decoded = jwt.verify(body.accessToken, process.env.JWT_SECRET!) as jwt.JwtPayload;
  assert.equal(decoded.sub, user.id);
  assert.equal(decoded.exp! - decoded.iat!, 3600);
  assert.match(response.headers.get('set-cookie')!, /HttpOnly/i);
  assert.match(response.headers.get('set-cookie')!, /Max-Age=604800/i);
  assert.equal(sessionData.userId, user.id);
  assert.equal(sessionData.tokenHash.length, 64);
});

test('refresh rotates the cookie and keeps the original seven-day session deadline', async () => {
  const oldToken = 'a'.repeat(43);
  const oldHash = createHash('sha256').update(oldToken).digest('hex');
  const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  let revoked = false;
  let replacement: any;
  stub(prisma, '$transaction', async (run: any) => run(prisma));
  stub((prisma as any).refreshSession, 'findUnique', async () => ({
    id: 'session-old', userId: user.id, familyId: 'family-id', tokenHash: oldHash,
    expiresAt, revokedAt: null, createdAt: new Date(), user,
  }));
  stub((prisma as any).refreshSession, 'updateMany', async () => { revoked = true; return { count: 1 }; });
  stub((prisma as any).refreshSession, 'create', async ({ data }: any) => { replacement = data; return { id: 'session-new', ...data }; });
  const { response, body } = await request('/api/v1/auth/refresh', {
    method: 'POST', headers: { Cookie: `refreshToken=${oldToken}` },
  });
  assert.equal(response.status, 200);
  assert.equal(body.expiresIn, 3600);
  assert.ok(jwt.verify(body.accessToken, process.env.JWT_SECRET!));
  assert.equal(revoked, true);
  assert.equal(replacement.familyId, 'family-id');
  assert.equal(replacement.expiresAt.getTime(), expiresAt.getTime());
  assert.notEqual(replacement.tokenHash, oldHash);
  assert.match(response.headers.get('set-cookie')!, /HttpOnly/i);
  assert.match(response.headers.get('set-cookie')!, /Max-Age=2591\d\d/i);
  assert.equal('refreshToken' in body, false);
});

test('reused refresh token revokes its family', async () => {
  const oldToken = 'b'.repeat(43);
  let familyRevoked = false;
  stub(prisma, '$transaction', async (run: any) => run(prisma));
  stub((prisma as any).refreshSession, 'findUnique', async () => ({
    id: 'session-old', userId: user.id, familyId: 'family-id',
    expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date(), user,
  }));
  stub((prisma as any).refreshSession, 'updateMany', async ({ where }: any) => {
    familyRevoked = where.familyId === 'family-id';
    return { count: 1 };
  });
  const { response, body } = await request('/api/v1/auth/refresh', {
    method: 'POST', headers: { Cookie: `refreshToken=${oldToken}` },
  });
  assert.equal(response.status, 401);
  assert.equal(body.code, 'UNAUTHORIZED');
  assert.equal(familyRevoked, true);
});

test('logout revokes the current refresh session and clears its cookie', async () => {
  let revoked = false;
  stub(prisma, '$transaction', async (run: any) => run(prisma));
  stub((prisma as any).refreshSession, 'findUnique', async () => ({ id: 'session-current', familyId: 'family-id' }));
  stub((prisma as any).refreshSession, 'updateMany', async () => { revoked = true; return { count: 1 }; });
  const { response, body } = await request('/api/v1/auth/logout', {
    method: 'POST', headers: { Cookie: `refreshToken=${'c'.repeat(43)}` },
  });
  assert.equal(response.status, 200);
  assert.equal(body.message, 'Đăng xuất thành công');
  assert.equal(revoked, true);
  assert.match(response.headers.get('set-cookie')!, /Max-Age=0/i);
});

test('login does not create a refresh session when JWT signing is unavailable', async () => {
  const passwordHash = await bcrypt.hash('Password@123', 4);
  stub(prisma.user, 'findFirst', async () => ({ ...user, passwordHash }));
  let created = false;
  stub((prisma as any).refreshSession, 'create', async () => { created = true; throw new Error('unexpected session'); });
  const original = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  try {
    const { response, body } = await request('/api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user.email, password: 'Password@123' }),
    });
    assert.equal(response.status, 500);
    assert.equal(body.code, 'INTERNAL_ERROR');
    assert.equal(created, false);
  } finally {
    process.env.JWT_SECRET = original;
  }
});

test('refresh keeps the existing cookie when the database fails', async () => {
  stub(prisma, '$transaction', async () => { throw new Error('database unavailable'); });
  const { response, body } = await request('/api/v1/auth/refresh', {
    method: 'POST', headers: { Cookie: `refreshToken=${'d'.repeat(43)}` },
  });
  assert.equal(response.status, 500);
  assert.equal(body.code, 'INTERNAL_ERROR');
  assert.equal(response.headers.get('set-cookie'), null);
});

test('register rejects passwords that bcrypt would truncate after 72 UTF-8 bytes', async () => {
  stub(prisma.user, 'create', async ({ data }: any) => ({ ...user, ...data }));
  const { response, body } = await request('/api/v1/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fullName: user.fullName, email: user.email, phone: user.phone, password: 'Aa1!' + 'x'.repeat(69), confirmPassword: 'Aa1!' + 'x'.repeat(69), acceptedTerms: true }),
  });
  assert.equal(response.status, 400);
  assert.ok(body.errors.password);
});

test('password limit counts UTF-8 bytes for non-ASCII input', async () => {
  const password = 'Aa1!' + 'é'.repeat(35);
  const { response, body } = await request('/api/v1/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fullName: user.fullName, email: user.email, phone: user.phone, password, confirmPassword: password, acceptedTerms: true }),
  });
  assert.equal(response.status, 400);
  assert.ok(body.errors.password);
});

test('login rejects a password beyond the bcrypt byte limit before database access', async () => {
  stub(prisma.user, 'findFirst', async () => { throw new Error('unexpected query'); });
  const { response, body } = await request('/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user.email, password: 'Aa1!' + 'x'.repeat(69) }),
  });
  assert.equal(response.status, 400);
  assert.ok(body.errors.password);
});

test('refresh retries a serialization conflict then revokes a replayed token family', async () => {
  let attempts = 0;
  let familyRevoked = false;
  stub(prisma, '$transaction', async (run: any, options: any) => {
    assert.equal(options.isolationLevel, 'Serializable');
    attempts++;
    if (attempts === 1) throw { code: 'P2034' };
    return run(prisma);
  });
  stub((prisma as any).refreshSession, 'findUnique', async () => ({
    id: 'session-old', userId: user.id, familyId: 'family-id',
    expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date(), user,
  }));
  stub((prisma as any).refreshSession, 'updateMany', async ({ where }: any) => {
    familyRevoked = where.familyId === 'family-id';
    return { count: 1 };
  });
  const { response } = await request('/api/v1/auth/refresh', {
    method: 'POST', headers: { Cookie: `refreshToken=${'e'.repeat(43)}` },
  });
  assert.equal(response.status, 401);
  assert.equal(attempts, 2);
  assert.equal(familyRevoked, true);
});

test('logout with an already rotated cookie revokes the active token family', async () => {
  let familyRevoked = false;
  stub(prisma, '$transaction', async (run: any) => run(prisma));
  stub((prisma as any).refreshSession, 'findUnique', async () => ({ id: 'session-old', familyId: 'family-id', revokedAt: new Date() }));
  stub((prisma as any).refreshSession, 'updateMany', async ({ where }: any) => {
    familyRevoked = where.familyId === 'family-id';
    return { count: 1 };
  });
  const { response } = await request('/api/v1/auth/logout', {
    method: 'POST', headers: { Cookie: `refreshToken=${'f'.repeat(43)}` },
  });
  assert.equal(response.status, 200);
  assert.equal(familyRevoked, true);
});
