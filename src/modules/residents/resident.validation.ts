import { z } from 'zod';
import {
  RESIDENT_INVITATION_STATUS,
  type ResidentInvitationStatus,
} from '../../common/constants/phase3-status';
import { ApiError } from '../../common/errors/api-error';
import type { ParsedInviteIdentifier, ResidentInvitationListQuery } from './resident.types';

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VIETNAM_PHONE_REGEX = /^0\d{9}$/;

function parseZod<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (result.success) {
    return result.data;
  }

  const errors: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const field = issue.path.join('.') || '_';
    (errors[field] ??= []).push(issue.message);
  }
  throw new ApiError(400, 'VALIDATION_ERROR', 'Dữ liệu đầu vào không hợp lệ', errors);
}

function validateUuidParam(value: unknown, field: string, message: string): string {
  if (typeof value !== 'string' || !UUID_REGEX.test(value.trim())) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Dữ liệu đầu vào không hợp lệ', {
      [field]: [message],
    });
  }
  return value.trim();
}

const createInvitationBodySchema = z
  .object({
    identifier: z
      .string({
        error: 'Định danh người được mời phải là email hoặc số điện thoại 10 chữ số bắt đầu bằng 0',
      })
      .trim()
      .min(1, 'Định danh người được mời không được để trống')
      .max(255, 'Định danh người được mời không được vượt quá 255 ký tự'),
  })
  .strict();

const emailSchema = z.string().email().max(255);

function optionalIntQueryField(fieldLabel: string, min: number, max?: number) {
  let numSchema = z
    .number({ error: `${fieldLabel} phải là số nguyên` })
    .int(`${fieldLabel} phải là số nguyên`)
    .min(min, `${fieldLabel} phải lớn hơn hoặc bằng ${min}`);

  if (max !== undefined) {
    numSchema = numSchema.max(max, `${fieldLabel} không được vượt quá ${max}`);
  }

  return z.preprocess((val) => {
    if (val === undefined || val === null || val === '') {
      return undefined;
    }
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed === '') {
        return undefined;
      }
      if (!/^\d+$/.test(trimmed)) {
        return val;
      }
      const num = Number(trimmed);
      return Number.isSafeInteger(num) ? num : val;
    }
    return val;
  }, numSchema.optional());
}

const INVITATION_STATUS_VALUES = Object.values(RESIDENT_INVITATION_STATUS) as [
  ResidentInvitationStatus,
  ...ResidentInvitationStatus[],
];

const invitationListQuerySchema = z.object({
  status: z
    .enum(INVITATION_STATUS_VALUES, {
      error: 'Trạng thái lời mời không hợp lệ',
    })
    .optional(),
  page: optionalIntQueryField('Số trang', 1),
  limit: optionalIntQueryField('Giới hạn bản ghi mỗi trang', 1, 50),
  pageSize: optionalIntQueryField('Giới hạn bản ghi mỗi trang', 1, 50),
});

export function validateContractId(contractId: unknown): string {
  return validateUuidParam(contractId, 'contractId', 'Mã hợp đồng phải là UUID hợp lệ');
}

export function validateInvitationId(invitationId: unknown): string {
  return validateUuidParam(invitationId, 'invitationId', 'Mã lời mời phải là UUID hợp lệ');
}

export function validateUserId(userId: unknown): string {
  return validateUuidParam(userId, 'userId', 'Mã người dùng phải là UUID hợp lệ');
}

export function validateCreateInvitationBody(body: unknown): ParsedInviteIdentifier {
  const { identifier } = parseZod(createInvitationBodySchema, body);

  if (VIETNAM_PHONE_REGEX.test(identifier)) {
    return {
      type: 'PHONE',
      value: identifier,
    };
  }

  if (emailSchema.safeParse(identifier).success) {
    return {
      type: 'EMAIL',
      value: identifier.toLowerCase(),
    };
  }

  throw new ApiError(400, 'VALIDATION_ERROR', 'Dữ liệu đầu vào không hợp lệ', {
    identifier: [
      'Định danh người được mời phải là email hoặc số điện thoại 10 chữ số bắt đầu bằng 0',
    ],
  });
}

export function validateInvitationListQuery(query: unknown): ResidentInvitationListQuery {
  const normalized = query && typeof query === 'object' ? query : {};
  const parsed = parseZod(invitationListQuerySchema, normalized);

  return {
    status: parsed.status,
    page: parsed.page ?? 1,
    limit: parsed.limit ?? parsed.pageSize ?? 20,
  };
}
