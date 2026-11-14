import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import type {
  CreatePropertyInput,
  UpdatePropertyInput,
  PropertyListQuery,
} from './property.types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const propertyPayloadSchema = z
  .object({
    name: z
      .string({ error: 'Tên khu trọ là bắt buộc' })
      .trim()
      .min(1, 'Tên khu trọ không được để trống')
      .max(200, 'Tên khu trọ không được vượt quá 200 ký tự'),
    address: z
      .string({ error: 'Địa chỉ là bắt buộc' })
      .trim()
      .min(1, 'Địa chỉ không được để trống')
      .max(500, 'Địa chỉ không được vượt quá 500 ký tự'),
    houseRules: z
      .string()
      .trim()
      .max(2000, 'Nội quy không được vượt quá 2000 ký tự')
      .nullable()
      .optional()
      .transform((val) => (val && val.length > 0 ? val : null)),
    coverImageUrl: z
      .preprocess(
        (val) => (typeof val === 'string' && val.trim() === '' ? null : val),
        z.string().trim().url('Đường dẫn ảnh bìa không hợp lệ').nullable().optional(),
      )
      .transform((val) => (val && val.length > 0 ? val : null)),
    amenityIds: z
      .array(z.string().regex(UUID_REGEX, 'Mã tiện ích phải là UUID hợp lệ'))
      .optional()
      .default([])
      .transform((ids) => Array.from(new Set(ids))),
  })
  .strict();

const createPropertySchema = propertyPayloadSchema;
const updatePropertySchema = propertyPayloadSchema;

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

export function validateCreateProperty(body: unknown): CreatePropertyInput {
  return parseZod(createPropertySchema, body);
}

export function validateUpdateProperty(body: unknown): UpdatePropertyInput {
  return parseZod(updatePropertySchema, body);
}

export function validatePropertyListQuery(query: any): PropertyListQuery {
  const pageRaw = parseInt(String(query?.page ?? '1'), 10);
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  const pageSizeRaw = parseInt(String(query?.pageSize ?? '10'), 10);
  let pageSize = Number.isInteger(pageSizeRaw) && pageSizeRaw > 0 ? pageSizeRaw : 10;
  if (pageSize > 50) pageSize = 50;

  const searchRaw = typeof query?.search === 'string' ? query.search.trim() : undefined;
  const search = searchRaw && searchRaw.length > 0 ? searchRaw : undefined;

  const statusRaw = typeof query?.status === 'string' ? query.status.trim().toUpperCase() : undefined;
  const status = statusRaw && ['ACTIVE', 'INACTIVE', 'ARCHIVED'].includes(statusRaw) ? statusRaw : undefined;

  return { page, pageSize, search, status };
}

export function validatePropertyId(id: unknown): string {
  if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Định dạng mã khu trọ (propertyId) không hợp lệ', {
      propertyId: ['Mã khu trọ phải là UUID hợp lệ'],
    });
  }
  return id;
}
