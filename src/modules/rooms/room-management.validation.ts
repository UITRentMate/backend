import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import type {
  CreateRoomInput,
  UpdateRoomInput,
  UpdateOperationalStatusInput,
  UpdateVisibilityInput,
  LandlordRoomListQuery,
} from './room-management.types';

export const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

export const serviceFeeInputSchema = z
  .object({
    feeName: z
      .string({ error: 'Tên phí dịch vụ là bắt buộc' })
      .trim()
      .min(1, 'Tên phí dịch vụ không được để trống')
      .max(100, 'Tên phí dịch vụ không được vượt quá 100 ký tự'),
    monthlyAmount: z
      .number({ error: 'Mức phí dịch vụ hàng tháng là bắt buộc' })
      .min(0, 'Mức phí dịch vụ không được là số âm'),
    isRequired: z.boolean().optional().default(false),
  })
  .strict();

export const createRoomSchema = z
  .object({
    roomCode: z
      .string({ error: 'Mã phòng là bắt buộc' })
      .trim()
      .min(1, 'Mã phòng không được để trống')
      .max(50, 'Mã phòng không được vượt quá 50 ký tự'),
    floor: z
      .number({ error: 'Số tầng phải là số' })
      .int('Số tầng phải là số nguyên')
      .min(0, 'Số tầng không được là số âm')
      .max(200, 'Số tầng không được vượt quá 200')
      .nullable()
      .optional()
      .default(null),
    areaM2: z
      .number({ error: 'Diện tích phòng là bắt buộc' })
      .gt(0, 'Diện tích phòng phải lớn hơn 0')
      .max(1000, 'Diện tích phòng không được vượt quá 1000 m²'),
    maxOccupants: z
      .number({ error: 'Sức chứa tối đa là bắt buộc' })
      .int('Sức chứa tối đa phải là số nguyên')
      .min(1, 'Sức chứa tối đa phải từ 1 người trở lên')
      .max(50, 'Sức chứa tối đa không được vượt quá 50 người'),
    monthlyRent: z
      .number({ error: 'Giá thuê hàng tháng là bắt buộc' })
      .min(0, 'Giá thuê hàng tháng không được là số âm'),
    depositRequired: z
      .number({ error: 'Tiền đặt cọc là bắt buộc' })
      .min(0, 'Tiền đặt cọc không được là số âm'),
    electricityRate: z
      .number({ error: 'Đơn giá điện là bắt buộc' })
      .min(0, 'Đơn giá điện không được là số âm'),
    waterRate: z
      .number({ error: 'Đơn giá nước là bắt buộc' })
      .min(0, 'Đơn giá nước không được là số âm'),
    amenityIds: z
      .array(z.string().regex(UUID_REGEX, 'Mã tiện ích phải là UUID hợp lệ'))
      .optional()
      .default([])
      .transform((ids) => Array.from(new Set(ids))),
    serviceFees: z.array(serviceFeeInputSchema).optional().default([]),
  })
  .strict();

export const updateRoomSchema = createRoomSchema;

export const updateOperationalStatusSchema = z
  .object({
    occupancyStatus: z.enum(['VACANT', 'MAINTENANCE'], {
      error: 'Trạng thái vận hành chỉ được phép là VACANT hoặc MAINTENANCE',
    }),
  })
  .strict();

export const updateVisibilitySchema = z
  .object({
    visibilityStatus: z.enum(['VISIBLE', 'HIDDEN'], {
      error: 'Trạng thái hiển thị chỉ được phép là VISIBLE hoặc HIDDEN',
    }),
  })
  .strict();

export const landlordRoomListQuerySchema = z.object({
  page: z.preprocess((val) => {
    const num = parseInt(String(val ?? '1'), 10);
    return Number.isInteger(num) && num > 0 ? num : 1;
  }, z.number().int().min(1).default(1)),
  pageSize: z.preprocess((val) => {
    const num = parseInt(String(val ?? '10'), 10);
    if (!Number.isInteger(num) || num < 1) return 10;
    return num > 50 ? 50 : num;
  }, z.number().int().min(1).max(50).default(10)),
  search: z.preprocess((val) => {
    if (typeof val !== 'string') return undefined;
    const trimmed = val.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }, z.string().optional()),
  occupancyStatus: z.preprocess((val) => {
    if (typeof val !== 'string') return undefined;
    const upper = val.trim().toUpperCase();
    return ['VACANT', 'MAINTENANCE', 'HELD', 'RENTED'].includes(upper) ? upper : undefined;
  }, z.string().optional()),
  visibilityStatus: z.preprocess((val) => {
    if (typeof val !== 'string') return undefined;
    const upper = val.trim().toUpperCase();
    return ['VISIBLE', 'HIDDEN'].includes(upper) ? upper : undefined;
  }, z.string().optional()),
});

function parseZod<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  const errors: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const field = issue.path.join('.') || '_';
    (errors[field] ??= []).push(issue.message);
  }
  throw new ApiError(400, 'VALIDATION_ERROR', 'Dữ liệu đầu vào không hợp lệ', errors);
}

export function validateCreateRoom(body: unknown): CreateRoomInput {
  return parseZod(createRoomSchema, body);
}

export function validateUpdateRoom(body: unknown): UpdateRoomInput {
  return parseZod(updateRoomSchema, body);
}

export function validateUpdateOperationalStatus(body: unknown): UpdateOperationalStatusInput {
  if (
    typeof body === 'object' &&
    body !== null &&
    'occupancyStatus' in body &&
    typeof (body as any).occupancyStatus === 'string'
  ) {
    const rawStatus = (body as any).occupancyStatus.trim().toUpperCase();
    if (rawStatus === 'HELD' || rawStatus === 'RENTED') {
      throw new ApiError(
        409,
        'INVALID_STATUS_TRANSITION',
        'Chủ trọ không được phép tự chuyển trạng thái phòng sang HELD hoặc RENTED',
      );
    }
  }
  return parseZod(updateOperationalStatusSchema, body);
}

export function validateUpdateVisibility(body: unknown): UpdateVisibilityInput {
  return parseZod(updateVisibilitySchema, body);
}

export function validateLandlordRoomListQuery(query: unknown): LandlordRoomListQuery {
  return landlordRoomListQuerySchema.parse(query ?? {});
}

export function validateRoomId(id: unknown): string {
  if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Định dạng mã phòng (roomId) không hợp lệ', {
      roomId: ['Mã phòng phải là UUID hợp lệ'],
    });
  }
  return id;
}

export function validatePropertyId(id: unknown): string {
  if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Định dạng mã khu trọ (propertyId) không hợp lệ', {
      propertyId: ['Mã khu trọ phải là UUID hợp lệ'],
    });
  }
  return id;
}
