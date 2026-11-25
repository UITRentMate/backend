import { createHash, randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { ApiError } from '../../common/errors/api-error';

export const ACCESS_TTL_SECONDS = 60 * 60;
export const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;
export const REFRESH_COOKIE = 'refreshToken';

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');
  return secret;
}

export function assertJwtConfigured(): void {
  jwtSecret();
}

export function signAccessToken(userId: string): string {
  return jwt.sign({}, jwtSecret(), {
    algorithm: 'HS256',
    subject: userId,
    issuer: 'rentmate',
    audience: 'rentmate-api',
    expiresIn: ACCESS_TTL_SECONDS,
  });
}

export function verifyAccessToken(token: string): string {
  try {
    const claims = jwt.verify(token, jwtSecret(), {
      algorithms: ['HS256'],
      issuer: 'rentmate',
      audience: 'rentmate-api',
    });
    if (typeof claims === 'string' || typeof claims.sub !== 'string') throw new Error('Missing subject');
    return claims.sub;
  } catch {
    throw new ApiError(401, 'UNAUTHORIZED', 'Thông tin xác thực không hợp lệ');
  }
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newRefreshToken(): { token: string; tokenHash: string; familyId: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashRefreshToken(token), familyId: randomUUID() };
}

export function hashRefreshToken(token: string): string {
  return sha256Hex(token);
}

/**
 * Tạo cặp rawToken ngẫu nhiên (64 ký tự hex) và tokenHash SHA-256 cho luồng đặt lại mật khẩu.
 */
export function newPasswordResetToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString('hex');
  return { rawToken, tokenHash: sha256Hex(rawToken) };
}

/**
 * Gắn query param token vào URL đặt lại mật khẩu frontend.
 */
export function buildPasswordResetUrl(baseUrl: string, rawToken: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('token', rawToken);
  return url.toString();
}

export function refreshCookieOptions(maxAge = REFRESH_TTL_SECONDS * 1000) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/api/v1/auth',
    maxAge,
  };
}

export function readRefreshCookie(header: string | undefined): string | null {
  if (!header) return null;
  const pair = header.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${REFRESH_COOKIE}=`));
  if (!pair) return null;
  const token = pair.slice(REFRESH_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
