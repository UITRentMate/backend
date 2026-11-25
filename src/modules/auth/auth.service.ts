import bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import { PHASE3_TIME_LIMITS_MS } from '../../common/constants/phase3-status';
import { ApiError } from '../../common/errors/api-error';
import { recordAuditLog } from '../../common/utils/audit-log.util';
import { getFrontendResetPasswordUrl } from '../../config/env';
import { prisma } from '../../infrastructure/database/prisma';
import { defaultEmailSender, type EmailSender } from '../../infrastructure/mail/email.service';
import { AuthRepository } from './auth.repository';
import {
  ACCESS_TTL_SECONDS,
  assertJwtConfigured,
  buildPasswordResetUrl,
  hashRefreshToken,
  newPasswordResetToken,
  newRefreshToken,
  REFRESH_TTL_SECONDS,
  sha256Hex,
  signAccessToken,
} from './auth.security';
import type { parseForgotPassword, parseLogin, parseRegister, parseResetPassword } from './auth.validation';

export const FORGOT_PASSWORD_NEUTRAL_RESPONSE = {
  success: true,
  message: 'Nếu email tồn tại trong hệ thống, hướng dẫn đặt lại mật khẩu đã được gửi.',
} as const;

export const PASSWORD_RESET_COOLDOWN_MS = 60 * 1000;

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

/**
 * Khởi tạo yêu cầu đặt lại mật khẩu, luôn trả về phản hồi trung tính để tránh lộ thông tin tài khoản.
 */
export async function forgotPassword(
  input: ReturnType<typeof parseForgotPassword>,
  emailSender: EmailSender = defaultEmailSender,
) {
  const user = await AuthRepository.findUserForPasswordResetByEmail(input.email);
  if (!user || user.accountStatus !== 'ACTIVE') {
    return FORGOT_PASSWORD_NEUTRAL_RESPONSE;
  }

  const frontendResetUrl = getFrontendResetPasswordUrl();
  const { rawToken, tokenHash } = newPasswordResetToken();
  const resetUrl = buildPasswordResetUrl(frontendResetUrl, rawToken);

  const txResult = await prisma.$transaction(async (tx) => {
    await AuthRepository.lockUserForPasswordReset(tx, user.id);

    const latestToken = await AuthRepository.findLatestPasswordResetTokenCreatedAt(user.id, tx);
    const now = new Date();
    if (latestToken && now.getTime() - latestToken.createdAt.getTime() < PASSWORD_RESET_COOLDOWN_MS) {
      return { issued: false as const };
    }

    const expiresAt = new Date(now.getTime() + PHASE3_TIME_LIMITS_MS.PASSWORD_RESET_TTL_MS);
    await AuthRepository.invalidateUnusedPasswordResetTokensInTx(tx, user.id, now);
    const issued = await AuthRepository.createPasswordResetTokenInTx(tx, {
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    return {
      issued: true as const,
      tokenId: issued.id,
      expiresAt: issued.expiresAt,
    };
  });

  if (!txResult.issued) {
    return FORGOT_PASSWORD_NEUTRAL_RESPONSE;
  }

  try {
    await emailSender.sendPasswordResetEmail({
      to: user.email,
      fullName: user.fullName,
      resetUrl,
      expiresInMinutes: Math.round(PHASE3_TIME_LIMITS_MS.PASSWORD_RESET_TTL_MS / 60000),
    });
  } catch (error) {
    await AuthRepository.deletePasswordResetTokenById(txResult.tokenId).catch((deleteError) => {
      console.error('[auth.forgotPassword] Failed to delete password reset token after email error', {
        tokenId: txResult.tokenId,
        errorName: deleteError instanceof Error ? deleteError.name : 'UnknownError',
      });
    });
    console.error('[auth.forgotPassword] Failed to send password reset email', {
      userId: user.id,
      tokenId: txResult.tokenId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    throw new ApiError(500, 'INTERNAL_ERROR', 'Hệ thống đang gặp sự cố tạm thời. Vui lòng thử lại sau.');
  }

  return FORGOT_PASSWORD_NEUTRAL_RESPONSE;
}

/**
 * Đặt lại mật khẩu từ token khôi phục một lần, thu hồi toàn bộ phiên đăng nhập và ghi nhận AuditLog.
 */
export async function resetPassword(input: ReturnType<typeof parseResetPassword>) {
  const tokenHash = sha256Hex(input.token);
  const usable = await AuthRepository.hasUsableResetToken(tokenHash, new Date());
  if (!usable) {
    throw new ApiError(
      400,
      'INVALID_OR_EXPIRED_RESET_TOKEN',
      'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn',
    );
  }

  const newPasswordHash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);
  const result = await withSerializableRetry(async (tx) => {
    const now = new Date();
    const consumed = await AuthRepository.consumeUsableResetTokenInTx(tx, tokenHash, now);
    if (!consumed) {
      return { status: 'invalid' as const };
    }

    await AuthRepository.updateUserPasswordAndRevokeSessionsInTx(tx, {
      userId: consumed.userId,
      newPasswordHash,
      revokedAt: now,
    });

    await recordAuditLog(tx, {
      actorId: consumed.userId,
      entityType: 'User',
      entityId: consumed.userId,
      action: 'PASSWORD_RESET_COMPLETED',
      oldData: null,
      newData: { sessionsRevoked: true, resetTokenId: consumed.tokenId },
    });

    return { status: 'ok' as const, userId: consumed.userId };
  });

  if (result.status !== 'ok') {
    throw new ApiError(
      400,
      'INVALID_OR_EXPIRED_RESET_TOKEN',
      'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn',
    );
  }

  return {
    success: true,
    message: 'Đặt lại mật khẩu thành công. Vui lòng đăng nhập lại.',
  };
}
