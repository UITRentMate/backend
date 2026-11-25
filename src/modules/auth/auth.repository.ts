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

/**
 * Repository truy vấn dữ liệu cho luồng quên/đặt lại mật khẩu trong module Auth.
 */
export const AuthRepository = {
  async findUserForPasswordResetByEmail(email: string): Promise<PasswordResetUserRecord | null> {
    return prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        fullName: true,
        accountStatus: true,
      },
    });
  },

  async findLatestPasswordResetTokenCreatedAt(userId: string): Promise<{ createdAt: Date } | null> {
    return prisma.passwordResetToken.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
  },

  async issuePasswordResetToken(
    userId: string,
    tokenHash: string,
    expiresAt: Date,
    now: Date,
  ): Promise<IssuedPasswordResetToken> {
    return prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.updateMany({
        where: { userId, usedAt: null },
        data: { usedAt: now },
      });

      return tx.passwordResetToken.create({
        data: {
          userId,
          tokenHash,
          expiresAt,
        },
        select: {
          id: true,
          expiresAt: true,
        },
      });
    });
  },

  async revokePasswordResetTokenById(tokenId: string, revokedAt: Date): Promise<void> {
    await prisma.passwordResetToken.updateMany({
      where: { id: tokenId, usedAt: null },
      data: { usedAt: revokedAt },
    });
  },
};
