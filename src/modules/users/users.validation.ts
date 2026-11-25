import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import { passwordSchema } from '../auth/auth.validation';
import type { ChangePasswordInput, UpdateUserProfileInput } from './users.types';

export const PHONE_REGEX = /^0\d{9}$/;
export const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
export const MIN_BIRTH_YEAR = 1900;
export const MIN_USER_AGE_YEARS = 16;

type DateValidationResult =
  | { valid: true; date: Date }
  | { valid: false; message: string };

/**
 * Kiểm tra chuỗi ngày sinh YYYY-MM-DD bằng phép tính lịch UTC thuần (tránh lệch múi giờ):
 * - Đúng định dạng YYYY-MM-DD và là ngày lịch hợp lệ (chặn 2020-02-30, 2021-02-29, ...)
 * - Từ 1900-01-01 trở đi
 * - Đủ 16 tuổi tính đến ngày hiện tại (theo UTC)
 */
export function validateDateOfBirthString(
  raw: string,
  referenceNow: Date = new Date(),
): DateValidationResult {
  if (!DATE_ONLY_REGEX.test(raw)) {
    return { valid: false, message: 'Ngày sinh phải có định dạng YYYY-MM-DD' };
  }

  const [yearStr, monthStr, dayStr] = raw.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);

  const utcDate = new Date(Date.UTC(year, month - 1, day));
  if (
    utcDate.getUTCFullYear() !== year ||
    utcDate.getUTCMonth() !== month - 1 ||
    utcDate.getUTCDate() !== day
  ) {
    return { valid: false, message: 'Ngày sinh không phải là ngày hợp lệ trên lịch' };
  }

  if (year < MIN_BIRTH_YEAR) {
    return { valid: false, message: 'Ngày sinh phải từ 1900-01-01 trở đi' };
  }

  const todayYear = referenceNow.getUTCFullYear();
  const todayMonth = referenceNow.getUTCMonth() + 1;
  const todayDay = referenceNow.getUTCDate();
  const cutoffYear = todayYear - MIN_USER_AGE_YEARS;

  const isAtLeastMinAge =
    year < cutoffYear ||
    (year === cutoffYear &&
      (month < todayMonth || (month === todayMonth && day <= todayDay)));

  if (!isAtLeastMinAge) {
    return { valid: false, message: 'Người dùng phải đủ 16 tuổi trở lên' };
  }

  return { valid: true, date: utcDate };
}

const updateUserProfileSchema = z
  .object({
    fullName: z
      .string({ error: 'Họ và tên phải là chuỗi ký tự' })
      .trim()
      .min(2, 'Họ và tên phải từ 2 đến 150 ký tự')
      .max(150, 'Họ và tên phải từ 2 đến 150 ký tự')
      .optional(),
    phone: z
      .string({ error: 'Số điện thoại phải là chuỗi ký tự' })
      .trim()
      .regex(PHONE_REGEX, 'Số điện thoại phải gồm 10 chữ số và bắt đầu bằng 0')
      .optional(),
    dateOfBirth: z
      .string({ error: 'Ngày sinh phải là chuỗi YYYY-MM-DD hoặc null' })
      .trim()
      .transform((val, ctx) => {
        const result = validateDateOfBirthString(val);
        if (!result.valid) {
          ctx.addIssue({
            code: 'custom',
            message: result.message,
          });
          return z.NEVER;
        }
        return result.date;
      })
      .nullable()
      .optional(),
    address: z
      .string({ error: 'Địa chỉ phải là chuỗi ký tự hoặc null' })
      .trim()
      .min(1, 'Địa chỉ không được để trống')
      .max(500, 'Địa chỉ không được vượt quá 500 ký tự')
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.fullName !== undefined ||
      data.phone !== undefined ||
      data.dateOfBirth !== undefined ||
      data.address !== undefined,
    {
      message: 'Cần cung cấp ít nhất một trường để cập nhật',
    },
  );

function parseZod<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const errors: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const field = issue.path.join('.') || '_';
    (errors[field] ??= []).push(issue.message);
  }
  throw new ApiError(400, 'VALIDATION_ERROR', 'Dữ liệu đầu vào không hợp lệ', errors);
}

/**
 * Validate payload cập nhật hồ sơ cá nhân (PUT /api/v1/users/me)
 */
export function validateUpdateUserProfile(body: unknown): UpdateUserProfileInput {
  return parseZod(updateUserProfileSchema, body);
}

const changePasswordSchema = z
  .object({
    currentPassword: z
      .string({ error: 'Mật khẩu hiện tại phải là chuỗi ký tự' })
      .min(1, 'Vui lòng nhập mật khẩu hiện tại')
      .refine(
        (value) => Buffer.byteLength(value, 'utf8') <= 72,
        'Mật khẩu hiện tại không được vượt 72 byte UTF-8',
      ),
    newPassword: passwordSchema,
    confirmNewPassword: z
      .string({ error: 'Mật khẩu xác nhận phải là chuỗi ký tự' })
      .min(1, 'Vui lòng nhập mật khẩu xác nhận'),
  })
  .strict()
  .refine((input) => input.newPassword === input.confirmNewPassword, {
    path: ['confirmNewPassword'],
    message: 'Mật khẩu xác nhận không khớp',
  })
  .refine((input) => input.newPassword !== input.currentPassword, {
    path: ['newPassword'],
    message: 'Mật khẩu mới không được trùng với mật khẩu hiện tại',
  });

/**
 * Validate payload đổi mật khẩu cá nhân (PATCH /api/v1/users/me/password)
 */
export function validateChangePassword(body: unknown): ChangePasswordInput {
  const { currentPassword, newPassword } = parseZod(changePasswordSchema, body);
  return { currentPassword, newPassword };
}
