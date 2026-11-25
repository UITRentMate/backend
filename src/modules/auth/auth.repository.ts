import type { PrismaDbClient } from '../../common/utils/audit-log.util';
import { prisma } from '../../infrastructure/database/prisma';

export interface PasswordResetUserRecord {
  id: string;
  email: string;
  fullName: string;
  accountStatus: string;
}

export interface IssuedPasswordResetToken {
  id: string;
  expiresAt: Date;
}

export interface ConsumedPasswordResetToken {
  tokenId: string;
  userId: string;
}

/**
 * Repository truy vấn dữ liệu cho luồng quên/đặt lại mật khẩu trong module Auth.
 */
export const AuthRepository = {
  async findUserForPasswordResetByEmail(
    email: string,
    db: PrismaDbClient = prisma,
  ): Promise<PasswordResetUserRecord | null> {
    return db.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        fullName: true,
        accountStatus: true,
      },
    });
  },

  async lockUserForPasswordReset(tx: PrismaDbClient, userId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
  },

  async findLatestPasswordResetTokenCreatedAt(
    userId: string,
    db: PrismaDbClient = prisma,
  ): Promise<{ createdAt: Date } | null> {
    return db.passwordResetToken.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
  },

  async invalidateUnusedPasswordResetTokensInTx(
    tx: PrismaDbClient,
    userId: string,
    usedAt: Date,
  ): Promise<void> {
    await tx.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt },
    });
  },

  async createPasswordResetTokenInTx(
    tx: PrismaDbClient,
    params: {
      userId: string;
      tokenHash: string;
      expiresAt: Date;
    },
  ): Promise<IssuedPasswordResetToken> {
    return tx.passwordResetToken.create({
      data: {
        userId: params.userId,
        tokenHash: params.tokenHash,
        expiresAt: params.expiresAt,
      },
      select: {
        id: true,
        expiresAt: true,
      },
    });
  },

  async deletePasswordResetTokenById(
    tokenId: string,
    db: PrismaDbClient = prisma,
  ): Promise<void> {
    await db.passwordResetToken.deleteMany({
      where: { id: tokenId },
    });
  },

  async hasUsableResetToken(
    tokenHash: string,
    now: Date,
    db: PrismaDbClient = prisma,
  ): Promise<boolean> {
    const record = await db.passwordResetToken.findUnique({
      where: { tokenHash },
      select: {
        expiresAt: true,
        usedAt: true,
        user: {
          select: {
            accountStatus: true,
          },
        },
      },
    });

    return Boolean(
      record &&
        record.usedAt === null &&
        record.expiresAt > now &&
        record.user.accountStatus === 'ACTIVE',
    );
  },

  async consumeUsableResetTokenInTx(
    tx: PrismaDbClient,
    tokenHash: string,
    now: Date,
  ): Promise<ConsumedPasswordResetToken | null> {
    const record = await tx.passwordResetToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        usedAt: true,
        user: {
          select: {
            id: true,
            accountStatus: true,
          },
        },
      },
    });

    if (
      !record ||
      record.usedAt !== null ||
      record.expiresAt <= now ||
      record.user.accountStatus !== 'ACTIVE'
    ) {
      return null;
    }

    const consumed = await tx.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });

    if (consumed.count !== 1) {
      return null;
    }

    return { tokenId: record.id, userId: record.userId };
  },

  async updateUserPasswordAndRevokeSessionsInTx(
    tx: PrismaDbClient,
    params: {
      userId: string;
      newPasswordHash: string;
      revokedAt: Date;
    },
  ): Promise<void> {
    await tx.user.update({
      where: { id: params.userId },
      data: { passwordHash: params.newPasswordHash },
      select: { id: true },
    });

    await tx.refreshSession.updateMany({
      where: { userId: params.userId, revokedAt: null },
      data: { revokedAt: params.revokedAt },
    });
  },
};
