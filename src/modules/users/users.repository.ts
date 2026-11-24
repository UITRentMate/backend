import type { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import type { UpdateUserProfileInput, UserProfileRecord } from './users.types';

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
}
