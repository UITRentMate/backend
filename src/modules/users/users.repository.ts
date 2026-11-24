import type { Prisma } from '@prisma/client';
import { recordAuditLog } from '../../common/utils/audit-log.util';
import { prisma } from '../../infrastructure/database/prisma';
import type {
  UpdateUserAvatarInput,
  UpdateUserProfileInput,
  UserAvatarContextRecord,
  UserPasswordContextRecord,
  UserProfileRecord,
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
   * Lấy thông tin nội bộ phục vụ thay thế avatar (bao gồm avatarCloudinaryPublicId cũ)
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
   * Cập nhật các trường hồ sơ cá nhân được phép của người dùng
   */
  public static async updateProfileById(
    userId: string,
    input: UpdateUserProfileInput,
  ): Promise<UserProfileRecord> {
    const data: Prisma.UserUpdateInput = {
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.dateOfBirth !== undefined ? { dateOfBirth: input.dateOfBirth } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
    };

    return prisma.user.update({
      where: { id: userId },
      data,
      select: USER_PROFILE_SELECT,
    });
  }

  /**
   * Cập nhật avatarUrl và avatarCloudinaryPublicId mới, trả về hồ sơ công khai an toàn
   */
  public static async updateAvatarById(
    userId: string,
    input: UpdateUserAvatarInput,
  ): Promise<UserProfileRecord> {
    return prisma.user.update({
      where: { id: userId },
      data: {
        avatarUrl: input.avatarUrl,
        avatarCloudinaryPublicId: input.avatarCloudinaryPublicId,
      },
      select: USER_PROFILE_SELECT,
    });
  }

  /**
   * Lấy thông tin nội bộ phục vụ xác thực và đổi mật khẩu (bao gồm passwordHash)
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
   * Cập nhật mật khẩu mới, thu hồi toàn bộ refresh session đang hoạt động và ghi audit log nguyên tử.
   */
  public static async changePasswordAndRevokeSessions(
    userId: string,
    newPasswordHash: string,
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash: newPasswordHash },
        select: { id: true },
      });

      await tx.refreshSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await recordAuditLog(tx, {
        actorId: userId,
        entityType: 'User',
        entityId: userId,
        action: 'PASSWORD_CHANGED',
        oldData: null,
        newData: { sessionsRevoked: true },
      });
    });
  }
}
