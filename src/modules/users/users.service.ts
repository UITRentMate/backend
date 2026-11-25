import bcrypt from 'bcrypt';
import { ApiError } from '../../common/errors/api-error';
import { recordAuditLog } from '../../common/utils/audit-log.util';
import { buildUserAvatarPublicId } from '../../common/utils/cloudinary.util';
import { prisma } from '../../infrastructure/database/prisma';
import { BCRYPT_ROUNDS, withSerializableRetry } from '../auth/auth.service';
import { mediaService } from '../media/media.service';
import { UsersRepository } from './users.repository';
import type {
  ChangePasswordInput,
  ChangePasswordResponseDTO,
  UpdateUserProfileInput,
  UserProfileDTO,
  UserProfileRecord,
} from './users.types';

function formatDateOnly(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().split('T')[0];
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().split('T')[0];
}

function toUserProfileDTO(user: UserProfileRecord): UserProfileDTO {
  return {
    userId: user.id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.accountStatus,
    avatarUrl: user.avatarUrl ?? null,
    dateOfBirth: formatDateOnly(user.dateOfBirth),
    address: user.address ?? null,
  };
}

function assertActiveUser<T extends { accountStatus: string }>(
  user: T | null,
): asserts user is T {
  if (!user) {
    throw new ApiError(
      401,
      'UNAUTHORIZED',
      'Tài khoản không tồn tại hoặc phiên đăng nhập không hợp lệ',
    );
  }
  if (user.accountStatus !== 'ACTIVE') {
    throw new ApiError(403, 'ACCOUNT_LOCKED', 'Tài khoản đã bị khóa hoặc chưa kích hoạt');
  }
}

function isPhoneUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2002') {
    return false;
  }
  const target =
    'meta' in error && error.meta && typeof error.meta === 'object' && 'target' in error.meta
      ? error.meta.target
      : undefined;
  const fields = Array.isArray(target) ? target : [target];
  return fields.some((field) => String(field).includes('phone'));
}

function isRecordNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2025');
}

/**
 * Lấy hồ sơ người dùng hiện tại
 */
export async function getCurrentUser(userId: string): Promise<UserProfileDTO> {
  const user = await UsersRepository.findProfileById(userId);
  assertActiveUser(user);
  return toUserProfileDTO(user);
}

/**
 * Cập nhật hồ sơ cá nhân của người dùng hiện tại
 */
export async function updateCurrentUser(
  userId: string,
  input: UpdateUserProfileInput,
): Promise<UserProfileDTO> {
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const locked = await UsersRepository.lockProfileStatusForUpdate(tx, userId);
      assertActiveUser(locked);
      return UsersRepository.updateProfileInTx(tx, userId, input);
    });
    return toUserProfileDTO(updated);
  } catch (error) {
    if (isPhoneUniqueConstraintError(error)) {
      throw new ApiError(409, 'PHONE_ALREADY_EXISTS', 'Số điện thoại đã được sử dụng');
    }
    if (isRecordNotFoundError(error)) {
      throw new ApiError(
        401,
        'UNAUTHORIZED',
        'Tài khoản không tồn tại hoặc phiên đăng nhập không hợp lệ',
      );
    }
    throw error;
  }
}

/**
 * Tải lên và cập nhật ảnh đại diện cho người dùng hiện tại (512x512 face-crop).
 * Rollback xóa ảnh mới trên Cloudinary nếu transaction thất bại; dọn ảnh cũ best-effort sau khi commit.
 */
export async function uploadMyAvatar(
  userId: string,
  fileBuffer: Buffer,
): Promise<UserProfileDTO> {
  const existing = await UsersRepository.findAvatarContextById(userId);
  assertActiveUser(existing);

  const publicId = buildUserAvatarPublicId(userId);
  const uploadResult = await mediaService.uploadStream(fileBuffer, {
    publicId,
    transformation: {
      width: 512,
      height: 512,
      crop: 'fill',
      gravity: 'face',
    },
  });

  let updated: UserProfileRecord;
  let previousPublicId: string | null = null;
  try {
    const txResult = await prisma.$transaction(async (tx) => {
      const locked = await UsersRepository.lockAvatarContextForUpdate(tx, userId);
      assertActiveUser(locked);

      const nextProfile = await UsersRepository.updateAvatarInTx(tx, userId, {
        avatarUrl: uploadResult.secureUrl,
        avatarCloudinaryPublicId: uploadResult.publicId,
      });

      return {
        updated: nextProfile,
        previousPublicId: locked.avatarCloudinaryPublicId,
      };
    });
    updated = txResult.updated;
    previousPublicId = txResult.previousPublicId;
  } catch (error) {
    // Bù trừ lỗi: Xóa ảnh vừa upload trên Cloudinary nếu cập nhật DB thất bại hoặc TOCTOU từ chối
    try {
      const rolledBack = await mediaService.deleteResource(uploadResult.publicId);
      if (!rolledBack) {
        console.warn(
          `[UsersService] Failed to rollback newly uploaded avatar ${uploadResult.publicId}`,
        );
      }
    } catch (rollbackError) {
      console.warn(
        `[UsersService] Failed to rollback newly uploaded avatar ${uploadResult.publicId}:`,
        rollbackError,
      );
    }

    if (isRecordNotFoundError(error)) {
      throw new ApiError(
        401,
        'UNAUTHORIZED',
        'Tài khoản không tồn tại hoặc phiên đăng nhập không hợp lệ',
      );
    }
    throw error;
  }

  // Dọn dẹp ảnh đại diện cũ best-effort, không làm hỏng request nếu xóa thất bại
  if (previousPublicId && previousPublicId !== uploadResult.publicId) {
    try {
      const deleted = await mediaService.deleteResource(previousPublicId);
      if (!deleted) {
        console.warn(`[UsersService] Failed to cleanup old avatar ${previousPublicId}`);
      }
    } catch (cleanupError) {
      console.warn(`[UsersService] Failed to cleanup old avatar ${previousPublicId}:`, cleanupError);
    }
  }

  return toUserProfileDTO(updated);
}

/**
 * Đổi mật khẩu cho người dùng hiện tại, thu hồi toàn bộ refresh session và ghi audit log.
 */
export async function changeMyPassword(
  userId: string,
  input: ChangePasswordInput,
): Promise<ChangePasswordResponseDTO> {
  const user = await UsersRepository.findPasswordContextById(userId);
  assertActiveUser(user);

  const isCurrentPasswordValid = await bcrypt.compare(input.currentPassword, user.passwordHash);
  if (!isCurrentPasswordValid) {
    throw new ApiError(400, 'INVALID_CURRENT_PASSWORD', 'Mật khẩu hiện tại không đúng');
  }

  if (input.newPassword === input.currentPassword) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Dữ liệu đầu vào không hợp lệ', {
      newPassword: ['Mật khẩu mới không được trùng với mật khẩu hiện tại'],
    });
  }

  const newHash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);

  try {
    await withSerializableRetry(async (tx) => {
      const locked = await UsersRepository.lockPasswordContextForUpdate(tx, userId);
      assertActiveUser(locked);

      if (locked.passwordHash !== user.passwordHash) {
        throw new ApiError(400, 'INVALID_CURRENT_PASSWORD', 'Mật khẩu hiện tại không đúng');
      }

      const revokedAt = new Date();
      await UsersRepository.updatePasswordHashInTx(tx, userId, newHash);
      await UsersRepository.revokeActiveRefreshSessionsInTx(tx, userId, revokedAt);
      await recordAuditLog(tx, {
        actorId: userId,
        entityType: 'User',
        entityId: userId,
        action: 'PASSWORD_CHANGED',
        oldData: null,
        newData: { sessionsRevoked: true },
      });
    });
  } catch (error) {
    if (isRecordNotFoundError(error)) {
      throw new ApiError(
        401,
        'UNAUTHORIZED',
        'Tài khoản không tồn tại hoặc phiên đăng nhập không hợp lệ',
      );
    }
    throw error;
  }

  return { message: 'Đổi mật khẩu thành công. Vui lòng đăng nhập lại' };
}
