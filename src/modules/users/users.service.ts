import { ApiError } from '../../common/errors/api-error';
import { UsersRepository } from './users.repository';
import type { UpdateUserProfileInput, UserProfileDTO, UserProfileRecord } from './users.types';

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

function assertActiveUserRecord(
  user: UserProfileRecord | null,
): asserts user is UserProfileRecord {
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
  assertActiveUserRecord(user);
  return toUserProfileDTO(user);
}

/**
 * Cập nhật hồ sơ cá nhân của người dùng hiện tại
 */
export async function updateCurrentUser(
  userId: string,
  input: UpdateUserProfileInput,
): Promise<UserProfileDTO> {
  const existing = await UsersRepository.findProfileById(userId);
  assertActiveUserRecord(existing);

  try {
    const updated = await UsersRepository.updateProfileById(userId, input);
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
