import { recordAuditLog } from '../../common/utils/audit-log.util';
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

export type ConsumeResetTokenResult =
  | { status: 'invalid' }
  | { status: 'ok'; userId: string };

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

  async consumeResetTokenAndUpdatePassword(params: {
    tokenHash: string;
    newPasswordHash: string;
    now: Date;
  }): Promise<ConsumeResetTokenResult> {
    const { tokenHash, newPasswordHash, now } = params;
    return prisma.$transaction(async (tx) => {
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
        return { status: 'invalid' as const };
      }

      const consumed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });

      if (consumed.count !== 1) {
        return { status: 'invalid' as const };
      }

      await tx.user.update({
        where: { id: record.userId },
        data: { passwordHash: newPasswordHash },
        select: { id: true },
      });

      await tx.refreshSession.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: now },
      });

      await recordAuditLog(tx, {
        actorId: record.userId,
        entityType: 'User',
        entityId: record.userId,
        action: 'PASSWORD_RESET_COMPLETED',
        oldData: null,
        newData: { sessionsRevoked: true, resetTokenId: record.id },
      });

      return { status: 'ok' as const, userId: record.userId };
    });
  },
};
