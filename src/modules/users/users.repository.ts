import type { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import type {
  UpdateUserAvatarInput,
  UpdateUserProfileInput,
  UserAvatarContextRecord,
  UserPasswordContextRecord,
  UserProfileRecord,
  UserStatusContextRecord,
} from './users.types';

/**
 * Chỉ chọn các trường hồ sơ công khai; tuyệt đối không truy vấn passwordHash hay avatarCloudinaryPublicId.
 */
export const USER_PROFILE_SELECT = {
  id: true,
  fullName: true,
  email: true,
  phone: true,
  role: true,
  accountStatus: true,
  avatarUrl: true,
  dateOfBirth: true,
  address: true,
} satisfies Prisma.UserSelect;

/**
 * Select nội bộ chỉ dùng khi cập nhật avatar để lấy avatarCloudinaryPublicId cũ phục vụ dọn dẹp Cloudinary.
 */
export const USER_AVATAR_CONTEXT_SELECT = {
  id: true,
  accountStatus: true,
  avatarCloudinaryPublicId: true,
} satisfies Prisma.UserSelect;

/**
 * Select nội bộ chỉ dùng khi đổi mật khẩu; tuyệt đối không trả passwordHash ra ngoài DTO.
 */
export const USER_PASSWORD_CONTEXT_SELECT = {
  id: true,
  accountStatus: true,
  passwordHash: true,
} satisfies Prisma.UserSelect;

export class UsersRepository {
  /**
   * Lấy thông tin hồ sơ người dùng theo ID
   */
  public static async findProfileById(userId: string): Promise<UserProfileRecord | null> {
    return prisma.user.findUnique({
      where: { id: userId },
      select: USER_PROFILE_SELECT,
    });
  }

  /**
   * Khóa bản ghi người dùng (FOR UPDATE) trong transaction để kiểm tra trạng thái tài khoản trước khi cập nhật hồ sơ.
   */
  public static async lockProfileStatusForUpdate(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<UserStatusContextRecord | null> {
    const rows = await tx.$queryRaw<Array<{ id: string; account_status: string }>>`
      SELECT id, account_status
      FROM users
      WHERE id = ${userId}::uuid
      FOR UPDATE
    `;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) return null;

    return {
      id: row.id,
      accountStatus: row.account_status,
    };
  }

  /**
   * Cập nhật các trường hồ sơ cá nhân được phép của người dùng trong transaction.
   */
  public static async updateProfileInTx(
    tx: Prisma.TransactionClient,
    userId: string,
    input: UpdateUserProfileInput,
  ): Promise<UserProfileRecord> {
    const data: Prisma.UserUpdateInput = {
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.dateOfBirth !== undefined ? { dateOfBirth: input.dateOfBirth } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
    };

    return tx.user.update({
      where: { id: userId },
      data,
      select: USER_PROFILE_SELECT,
    });
  }

  /**
   * Lấy thông tin nội bộ phục vụ pre-check trước khi upload avatar lên Cloudinary.
   */
  public static async findAvatarContextById(
    userId: string,
  ): Promise<UserAvatarContextRecord | null> {
    return prisma.user.findUnique({
      where: { id: userId },
      select: USER_AVATAR_CONTEXT_SELECT,
    });
  }

  /**
   * Khóa bản ghi người dùng (FOR UPDATE) trong transaction để đọc avatarCloudinaryPublicId mới nhất và tuần tự hóa cập nhật avatar.
   */
  public static async lockAvatarContextForUpdate(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<UserAvatarContextRecord | null> {
    const rows = await tx.$queryRaw<
      Array<{ id: string; account_status: string; avatar_cloudinary_public_id: string | null }>
    >`
      SELECT id, account_status, avatar_cloudinary_public_id
      FROM users
      WHERE id = ${userId}::uuid
      FOR UPDATE
    `;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) return null;

    return {
      id: row.id,
      accountStatus: row.account_status,
      avatarCloudinaryPublicId: row.avatar_cloudinary_public_id,
    };
  }

  /**
   * Cập nhật avatarUrl và avatarCloudinaryPublicId mới trong transaction, trả về hồ sơ công khai an toàn.
   */
  public static async updateAvatarInTx(
    tx: Prisma.TransactionClient,
    userId: string,
    input: UpdateUserAvatarInput,
  ): Promise<UserProfileRecord> {
    return tx.user.update({
      where: { id: userId },
      data: {
        avatarUrl: input.avatarUrl,
        avatarCloudinaryPublicId: input.avatarCloudinaryPublicId,
      },
      select: USER_PROFILE_SELECT,
    });
  }

  /**
   * Lấy thông tin nội bộ phục vụ xác thực và đổi mật khẩu (bao gồm passwordHash).
   */
  public static async findPasswordContextById(
    userId: string,
  ): Promise<UserPasswordContextRecord | null> {
    return prisma.user.findUnique({
      where: { id: userId },
      select: USER_PASSWORD_CONTEXT_SELECT,
    });
  }

  /**
   * Khóa bản ghi người dùng (FOR UPDATE) trong transaction để phát hiện đổi mật khẩu đồng thời và kiểm tra trạng thái tài khoản.
   */
  public static async lockPasswordContextForUpdate(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<UserPasswordContextRecord | null> {
    const rows = await tx.$queryRaw<
      Array<{ id: string; account_status: string; password_hash: string }>
    >`
      SELECT id, account_status, password_hash
      FROM users
      WHERE id = ${userId}::uuid
      FOR UPDATE
    `;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) return null;

    return {
      id: row.id,
      accountStatus: row.account_status,
      passwordHash: row.password_hash,
    };
  }

  /**
   * Cập nhật passwordHash mới trong transaction.
   */
  public static async updatePasswordHashInTx(
    tx: Prisma.TransactionClient,
    userId: string,
    passwordHash: string,
  ): Promise<void> {
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash },
      select: { id: true },
    });
  }

  /**
   * Thu hồi toàn bộ refresh session đang hoạt động của người dùng trong transaction.
   */
  public static async revokeActiveRefreshSessionsInTx(
    tx: Prisma.TransactionClient,
    userId: string,
    revokedAt: Date,
  ): Promise<void> {
    await tx.refreshSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt },
    });
  }
}
