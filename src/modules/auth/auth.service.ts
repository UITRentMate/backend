import bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import { ApiError } from '../../common/errors/api-error';
import { prisma } from '../../infrastructure/database/prisma';
import { ACCESS_TTL_SECONDS, assertJwtConfigured, hashRefreshToken, newRefreshToken, REFRESH_TTL_SECONDS, signAccessToken } from './auth.security';
import type { parseLogin, parseRegister } from './auth.validation';

const BCRYPT_ROUNDS = 12;

async function withSerializableRetry<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2034') || attempt === 2) throw error;
    }
  }
  throw new Error('Serializable retry exhausted');
}

export async function register(input: ReturnType<typeof parseRegister>) {
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  try {
    const user = await prisma.user.create({
      data: {
        fullName: input.fullName,
        email: input.email,
        phone: input.phone,
        passwordHash,
        role: 'TENANT',
        accountStatus: 'ACTIVE',
      },
    });
    return { userId: user.id, fullName: user.fullName, role: user.role, status: user.accountStatus };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      const target = 'meta' in error && error.meta && typeof error.meta === 'object' && 'target' in error.meta ? error.meta.target : undefined;
      const fields = Array.isArray(target) ? target : [target];
      if (fields.some((field) => String(field).includes('email'))) throw new ApiError(409, 'EMAIL_ALREADY_EXISTS', 'Email đã được sử dụng');
      if (fields.some((field) => String(field).includes('phone'))) throw new ApiError(409, 'PHONE_ALREADY_EXISTS', 'Số điện thoại đã được sử dụng');
      throw new ApiError(409, 'ACCOUNT_ALREADY_EXISTS', 'Tài khoản đã tồn tại');
    }
    throw error;
  }
}

export async function login(input: ReturnType<typeof parseLogin>) {
  assertJwtConfigured();
  const user = await prisma.user.findFirst({
    where: { OR: [{ email: input.username }, { phone: input.username }] },
  });
  if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Thông tin đăng nhập không đúng');
  }
  if (user.accountStatus !== 'ACTIVE') throw new ApiError(403, 'ACCOUNT_LOCKED', 'Tài khoản không thể đăng nhập');
  const accessToken = signAccessToken(user.id);
  const refresh = newRefreshToken();
  await prisma.refreshSession.create({
    data: {
      userId: user.id,
      familyId: refresh.familyId,
      tokenHash: refresh.tokenHash,
      expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
    },
  });
  return {
    body: {
      user: { userId: user.id, role: user.role, status: user.accountStatus },
      accessToken,
      expiresIn: ACCESS_TTL_SECONDS,
    },
    refreshToken: refresh.token,
  };
}

export async function refreshSession(token: string) {
  assertJwtConfigured();
  const now = new Date();
  const next = newRefreshToken();
  const result = await withSerializableRetry(async (tx) => {
    const current = await tx.refreshSession.findUnique({
      where: { tokenHash: hashRefreshToken(token) },
      include: { user: true },
    });
    if (!current) return { status: 'invalid' as const };
    if (current.revokedAt) {
      await tx.refreshSession.updateMany({ where: { familyId: current.familyId, revokedAt: null }, data: { revokedAt: now } });
      return { status: 'invalid' as const };
    }
    if (current.expiresAt <= now) {
      await tx.refreshSession.updateMany({ where: { id: current.id, revokedAt: null }, data: { revokedAt: now } });
      return { status: 'invalid' as const };
    }
    if (current.user.accountStatus !== 'ACTIVE') {
      await tx.refreshSession.updateMany({ where: { familyId: current.familyId, revokedAt: null }, data: { revokedAt: now } });
      return { status: 'locked' as const };
    }
    const updated = await tx.refreshSession.updateMany({
      where: { id: current.id, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now },
    });
    if (updated.count !== 1) {
      await tx.refreshSession.updateMany({ where: { familyId: current.familyId, revokedAt: null }, data: { revokedAt: now } });
      return { status: 'invalid' as const };
    }
    await tx.refreshSession.create({
      data: {
        userId: current.userId,
        familyId: current.familyId,
        tokenHash: next.tokenHash,
        expiresAt: current.expiresAt,
      },
    });
    return { status: 'ok' as const, userId: current.userId, expiresAt: current.expiresAt };
  });
  if (result.status === 'locked') throw new ApiError(403, 'ACCOUNT_LOCKED', 'Tài khoản không thể đăng nhập');
  if (result.status !== 'ok') throw new ApiError(401, 'UNAUTHORIZED', 'Refresh token không hợp lệ');
  return {
    body: { accessToken: signAccessToken(result.userId), expiresIn: ACCESS_TTL_SECONDS },
    refreshToken: next.token,
    maxAge: Math.max(0, result.expiresAt.getTime() - Date.now()),
  };
}

export async function logout(token: string | null) {
  if (!token) return;
  await withSerializableRetry(async (tx) => {
    const current = await tx.refreshSession.findUnique({ where: { tokenHash: hashRefreshToken(token) } });
    if (!current) return;
    await tx.refreshSession.updateMany({
      where: { familyId: current.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });
}
