import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';

async function main() {
  process.loadEnvFile();
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
  if (databaseUrl.protocol !== 'postgresql:' || !['localhost', '127.0.0.1'].includes(databaseUrl.hostname) || databaseUrl.pathname !== '/rentmate_dev') {
    throw new Error('Manual smoke test chỉ được chạy với PostgreSQL rentmate_dev trên localhost');
  }
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || process.env.JWT_SECRET === 'REPLACE_ME') {
    throw new Error('Cần JWT_SECRET ngẫu nhiên dài ít nhất 32 ký tự');
  }

  const { app } = await import('../src/app');
  const { prisma } = await import('../src/infrastructure/database/prisma');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  let userId: string | undefined;
  const phone = '09' + String(randomInt(0, 100_000_000)).padStart(8, '0');
  const password = 'Manual@123abc';
  const input = {
    fullName: 'Manual Smoke User',
    email: `rentmate.manual.${randomUUID()}@example.com`,
    phone,
    password,
    confirmPassword: password,
    acceptedTerms: true,
  };

  async function request(path: string, init: RequestInit = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const raw = await response.text();
    const body = raw ? JSON.parse(raw) : null;
    return { response, body };
  }

  function jsonPost(body: unknown, headers: Record<string, string> = {}): RequestInit {
    return { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) };
  }

  try {
    const registered = await request('/api/v1/auth/register', jsonPost(input));
    assert.equal(registered.response.status, 201, 'register');
    userId = registered.body.userId;
    assert.equal(registered.body.role, 'TENANT');
    assert.equal(registered.body.status, 'ACTIVE');
    assert.equal('passwordHash' in registered.body, false);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    assert.notEqual(stored.passwordHash, password);
    assert.equal(await bcrypt.compare(password, stored.passwordHash), true);
    console.log('PASS register + bcrypt trong PostgreSQL');

    const duplicate = await request('/api/v1/auth/register', jsonPost(input));
    assert.equal(duplicate.response.status, 409, 'duplicate register');
    console.log('PASS email/phone trùng');

    const badLogin = await request('/api/v1/auth/login', jsonPost({ username: input.email, password: 'Wrong@123abc' }));
    assert.equal(badLogin.response.status, 401, 'bad login');
    console.log('PASS sai mật khẩu');

    const login = await request('/api/v1/auth/login', jsonPost({ username: input.email, password }));
    assert.equal(login.response.status, 200, 'login');
    assert.equal(login.body.expiresIn, 3600);
    assert.equal('refreshToken' in login.body, false);
    const accessToken = login.body.accessToken as string;
    const cookieA = login.response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookieA?.startsWith('refreshToken='));
    console.log('PASS login + JWT 1 giờ + refresh cookie');

    const me = await request('/api/v1/users/me', { headers: { Authorization: `Bearer ${accessToken}` } });
    assert.equal(me.response.status, 200, 'me');
    assert.equal(me.body.userId, userId);
    assert.equal('passwordHash' in me.body, false);
    console.log('PASS /users/me');

    const refreshed = await request('/api/v1/auth/refresh', { method: 'POST', headers: { Cookie: cookieA! } });
    assert.equal(refreshed.response.status, 200, 'refresh');
    const cookieB = refreshed.response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookieB && cookieB !== cookieA);
    const replay = await request('/api/v1/auth/refresh', { method: 'POST', headers: { Cookie: cookieA! } });
    assert.equal(replay.response.status, 401, 'replayed refresh token');
    const revokedFamily = await request('/api/v1/auth/refresh', { method: 'POST', headers: { Cookie: cookieB } });
    assert.equal(revokedFamily.response.status, 401, 'revoked refresh family');
    console.log('PASS refresh rotation + replay revocation');

    const loginAgain = await request('/api/v1/auth/login', jsonPost({ username: phone, password }));
    assert.equal(loginAgain.response.status, 200, 'phone login');
    const cookieC = loginAgain.response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookieC);
    const logout = await request('/api/v1/auth/logout', { method: 'POST', headers: { Cookie: cookieC } });
    assert.equal(logout.response.status, 200, 'logout');
    const afterLogout = await request('/api/v1/auth/refresh', { method: 'POST', headers: { Cookie: cookieC } });
    assert.equal(afterLogout.response.status, 401, 'refresh after logout');
    console.log('PASS phone login + logout');
  } finally {
    if (userId) await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error('Manual smoke test thất bại:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
