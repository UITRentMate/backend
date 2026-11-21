import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import type {
  CreateRentalRequestInput,
  RejectRentalRequestInput,
  RentalRequestFilterQuery,
} from './rental-request.types';

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_STRING_REGEX = /^\d{4}-\d{2}-\d{2}(T.*)?$/;

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

const createRentalRequestSchema = z
  .object({
    roomId: z
      .string({ error: 'Mã phòng trọ là bắt buộc' })
      .trim()
      .regex(UUID_REGEX, 'Mã phòng trọ phải là UUID hợp lệ'),
    desiredMoveInDate: z
      .string({ error: 'Ngày dự kiến bắt đầu thuê là bắt buộc' })
      .trim()
      .regex(DATE_STRING_REGEX, 'Ngày dự kiến bắt đầu thuê phải có định dạng YYYY-MM-DD hoặc ISO-8601')
      .refine((val) => {
        const parsed = new Date(val);
        return !Number.isNaN(parsed.getTime());
      }, 'Ngày dự kiến bắt đầu thuê không hợp lệ')
      .refine((val) => {
        const parsed = new Date(val);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        // Compare date
        return parsed >= today;
      }, 'Ngày dự kiến bắt đầu thuê không được ở trong quá khứ'),
    durationMonths: z
      .preprocess((val) => {
        if (val === null || val === undefined || val === '') return null;
        if (typeof val === 'string') {
          const num = Number(val);
          return Number.isNaN(num) ? val : num;
        }
        return val;
      }, z.number({ error: 'Thời hạn thuê phải là số nguyên' }).int('Thời hạn thuê phải là số nguyên').min(1, 'Thời hạn thuê tối thiểu là 1 tháng').max(60, 'Thời hạn thuê tối đa là 60 tháng').nullable().optional())
      .default(null),
    message: z
      .preprocess((val) => {
        if (val === null || val === undefined) return null;
        if (typeof val === 'string') {
          const trimmed = val.trim();
          return trimmed.length > 0 ? trimmed : null;
        }
        return val;
      }, z.string().max(1000, 'Lời nhắn không được vượt quá 1000 ký tự').nullable().optional())
      .default(null),
  })
  .strict();

const rejectRentalRequestSchema = z
  .object({
    reason: z
      .string({ error: 'Lý do từ chối là bắt buộc' })
      .trim()
      .min(1, 'Lý do từ chối không được để trống')
      .max(1000, 'Lý do từ chối không được vượt quá 1000 ký tự'),
  })
  .strict();

const rentalRequestFilterQuerySchema = z.object({
  status: z
    .enum(['PENDING', 'REJECTED'], {
      error: 'Trạng thái lọc chỉ được là PENDING hoặc REJECTED',
    })
    .optional(),
  roomId: z
    .string()
    .trim()
    .regex(UUID_REGEX, 'Mã phòng trọ phải là UUID hợp lệ')
    .optional(),
  page: z
    .preprocess((val) => {
      if (val === undefined || val === null || val === '') return 1;
      const num = Number(val);
      return Number.isNaN(num) ? 1 : num;
    }, z.number().int().min(1, 'Số trang phải lớn hơn hoặc bằng 1'))
    .default(1),
  pageSize: z
    .preprocess((val) => {
      if (val === undefined || val === null || val === '') return 10;
      const num = Number(val);
      return Number.isNaN(num) ? 10 : num;
    }, z.number().int().min(1, 'Số lượng bản ghi mỗi trang phải từ 1 đến 100').max(100, 'Số lượng bản ghi mỗi trang phải từ 1 đến 100'))
    .default(10),
});

export function validateCreateRentalRequest(body: unknown): CreateRentalRequestInput {
  return parseZod(createRentalRequestSchema, body);
}

export function validateRejectRentalRequest(body: unknown): RejectRentalRequestInput {
  return parseZod(rejectRentalRequestSchema, body);
}

export function validateRentalRequestFilterQuery(query: unknown): RentalRequestFilterQuery {
  return parseZod(rentalRequestFilterQuerySchema, query);
}

export function validateRentalRequestId(requestId: unknown): string {
  if (typeof requestId !== 'string' || !UUID_REGEX.test(requestId.trim())) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Mã yêu cầu thuê phải là UUID hợp lệ', {
      requestId: ['Mã yêu cầu thuê phải là UUID hợp lệ'],
    });
  }
  return requestId.trim();
}
