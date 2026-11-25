import { z } from 'zod';
import {
  REPAIR_COST_BEARER,
  REPAIR_TICKET_PRIORITY,
  REPAIR_TICKET_STATUS,
  type RepairCostBearer,
  type RepairTicketPriority,
  type RepairTicketStatus,
} from '../../common/constants/phase3-status';
import { ApiError } from '../../common/errors/api-error';
import type {
  AcceptRepairTicketInput,
  CompleteRepairTicketInput,
  CreateRepairTicketInput,
  RejectRepairCompletionInput,
  RepairTicketListQuery,
} from './repair-ticket.types';

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATETIME_WITH_TZ_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/i;
const DECIMAL_TWO_PLACES_REGEX = /^\d+(?:\.\d{1,2})?$/;

function isValidIsoDateTimeWithTz(value: string): boolean {
  const match = ISO_DATETIME_WITH_TZ_REGEX.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return false;
  }

  if (match[7]) {
    const offsetHour = Number(match[8]);
    const offsetMinute = Number(match[9]);
    if (offsetHour > 23 || offsetMinute > 59) {
      return false;
    }
  }

  const utcCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    utcCheck.getUTCFullYear() !== year ||
    utcCheck.getUTCMonth() !== month - 1 ||
    utcCheck.getUTCDate() !== day
  ) {
    return false;
  }

  return !Number.isNaN(Date.parse(value));
}

export const MAX_REPAIR_TICKET_PAGE = 10_000;
export const MAX_REPAIR_TICKET_LIMIT = 50;
export const MAX_REPAIR_COST = 999_999_999_999.99;
export const SCHEDULED_AT_PAST_GRACE_MS = 5 * 60 * 1000;

const TICKET_STATUS_VALUES = Object.values(REPAIR_TICKET_STATUS) as [
  RepairTicketStatus,
  ...RepairTicketStatus[],
];
const TICKET_PRIORITY_VALUES = Object.values(REPAIR_TICKET_PRIORITY) as [
  RepairTicketPriority,
  ...RepairTicketPriority[],
];
const COST_BEARER_VALUES = Object.values(REPAIR_COST_BEARER) as [
  RepairCostBearer,
  ...RepairCostBearer[],
];

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

function emptyStringToUndefined(val: unknown): unknown {
  if (val === undefined || val === null) {
    return undefined;
  }
  if (typeof val === 'string' && val.trim() === '') {
    return undefined;
  }
  return val;
}

function optionalUuidField(fieldLabel: string) {
  return z.preprocess(
    emptyStringToUndefined,
    z
      .string({ error: `${fieldLabel} phải là UUID hợp lệ` })
      .trim()
      .regex(UUID_REGEX, `${fieldLabel} phải là UUID hợp lệ`)
      .optional(),
  );
}

function optionalIntQueryField(fieldLabel: string, min: number, max: number) {
  return z.preprocess(
    (val) => {
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
        const parsed = Number(trimmed);
        return Number.isSafeInteger(parsed) ? parsed : val;
      }
      return val;
    },
    z
      .number({ error: `${fieldLabel} phải là số nguyên` })
      .int(`${fieldLabel} phải là số nguyên`)
      .min(min, `${fieldLabel} phải lớn hơn hoặc bằng ${min}`)
      .max(max, `${fieldLabel} không được vượt quá ${max}`)
      .optional(),
  );
}

const createRepairTicketSchema = z
  .object({
    roomId: optionalUuidField('Mã phòng'),
    propertyId: optionalUuidField('Mã khu trọ'),
    title: z
      .string({ error: 'Tiêu đề sự cố là bắt buộc' })
      .trim()
      .min(5, 'Tiêu đề sự cố phải có ít nhất 5 ký tự')
      .max(200, 'Tiêu đề sự cố không được vượt quá 200 ký tự'),
    description: z
      .string({ error: 'Mô tả sự cố là bắt buộc' })
      .trim()
      .min(10, 'Mô tả sự cố phải có ít nhất 10 ký tự')
      .max(2000, 'Mô tả sự cố không được vượt quá 2000 ký tự'),
    priority: z.preprocess(
      emptyStringToUndefined,
      z
        .enum(TICKET_PRIORITY_VALUES, {
          error: 'Mức độ ưu tiên phải thuộc LOW, MEDIUM, HIGH hoặc URGENT',
        })
        .optional(),
    ),
  })
  .superRefine((data, ctx) => {
    if (!data.roomId && !data.propertyId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roomId'],
        message: 'Phải cung cấp ít nhất roomId (phòng riêng) hoặc propertyId (khu vực chung)',
      });
    }
  });

const listRepairTicketsQuerySchema = z.object({
  status: z.preprocess(
    emptyStringToUndefined,
    z.enum(TICKET_STATUS_VALUES, { error: 'Trạng thái phiếu sự cố không hợp lệ' }).optional(),
  ),
  priority: z.preprocess(
    emptyStringToUndefined,
    z.enum(TICKET_PRIORITY_VALUES, { error: 'Mức độ ưu tiên không hợp lệ' }).optional(),
  ),
  propertyId: optionalUuidField('Mã khu trọ'),
  roomId: optionalUuidField('Mã phòng'),
  page: optionalIntQueryField('Số trang', 1, MAX_REPAIR_TICKET_PAGE),
  limit: optionalIntQueryField('Giới hạn bản ghi mỗi trang', 1, MAX_REPAIR_TICKET_LIMIT),
  pageSize: optionalIntQueryField('Giới hạn bản ghi mỗi trang', 1, MAX_REPAIR_TICKET_LIMIT),
});

const acceptRepairTicketSchema = z
  .object({
    resolutionPlan: z
      .string({ error: 'Phương án xử lý là bắt buộc' })
      .trim()
      .min(5, 'Phương án xử lý phải có ít nhất 5 ký tự')
      .max(1000, 'Phương án xử lý không được vượt quá 1000 ký tự'),
    scheduledAt: z
      .string({ error: 'Thời gian dự kiến sửa chữa là bắt buộc' })
      .trim()
      .refine(
        isValidIsoDateTimeWithTz,
        'Thời gian dự kiến sửa chữa phải đúng định dạng ISO-8601 kèm múi giờ (vd: 2026-11-25T09:00:00.000Z)',
      ),
  })
  .strict();

const completeRepairTicketSchema = z
  .object({
    repairCost: z.preprocess(
      (val) => {
        if (val === undefined || val === null) {
          return undefined;
        }
        if (typeof val === 'string') {
          const trimmed = val.trim();
          if (trimmed === '') {
            return undefined;
          }
          if (!DECIMAL_TWO_PLACES_REGEX.test(trimmed)) {
            return val;
          }
          const num = Number(trimmed);
          return Number.isFinite(num) ? num : val;
        }
        if (typeof val === 'number') {
          if (!Number.isFinite(val) || val < 0) {
            return val;
          }
          if (!DECIMAL_TWO_PLACES_REGEX.test(val.toString())) {
            return Number.NaN;
          }
        }
        return val;
      },
      z
        .number({
          error: 'Chi phí sửa chữa phải là số không âm hợp lệ (tối đa 2 chữ số thập phân)',
        })
        .min(0, 'Chi phí sửa chữa không được âm')
        .max(MAX_REPAIR_COST, `Chi phí sửa chữa không được vượt quá ${MAX_REPAIR_COST}`)
        .optional(),
    ),
    costBearer: z.preprocess(
      emptyStringToUndefined,
      z
        .enum(COST_BEARER_VALUES, {
          error: 'Bên chịu chi phí phải là LANDLORD hoặc TENANT',
        })
        .optional(),
    ),
  })
  .superRefine((data, ctx) => {
    if (data.repairCost !== undefined && data.costBearer === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['costBearer'],
        message: 'Vui lòng chọn bên chịu chi phí (LANDLORD hoặc TENANT) khi nhập chi phí sửa chữa',
      });
    }
    if (data.costBearer !== undefined && data.repairCost === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repairCost'],
        message: 'Vui lòng nhập chi phí sửa chữa khi đã chọn bên chịu chi phí',
      });
    }
  });

const rejectRepairCompletionSchema = z
  .object({
    reason: z
      .string({ error: 'Lý do nghiệm thu chưa đạt là bắt buộc' })
      .trim()
      .min(10, 'Lý do nghiệm thu chưa đạt phải có ít nhất 10 ký tự')
      .max(1000, 'Lý do nghiệm thu chưa đạt không được vượt quá 1000 ký tự'),
  })
  .strict();

export function validateTicketId(rawId: unknown): string {
  if (typeof rawId !== 'string' || !UUID_REGEX.test(rawId.trim())) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Dữ liệu đầu vào không hợp lệ', {
      ticketId: ['Mã phiếu sự cố phải là UUID hợp lệ'],
    });
  }
  return rawId.trim();
}

export function validateCreateRepairTicketBody(rawBody: unknown): CreateRepairTicketInput {
  const normalized = rawBody && typeof rawBody === 'object' ? rawBody : {};
  const parsed = parseZod(createRepairTicketSchema, normalized);
  return {
    roomId: parsed.roomId,
    propertyId: parsed.propertyId,
    title: parsed.title,
    description: parsed.description,
    priority: parsed.priority ?? REPAIR_TICKET_PRIORITY.MEDIUM,
  };
}

export function validateRepairTicketListQuery(rawQuery: unknown): RepairTicketListQuery {
  const normalized = rawQuery && typeof rawQuery === 'object' ? rawQuery : {};
  const parsed = parseZod(listRepairTicketsQuerySchema, normalized);
  return {
    status: parsed.status,
    priority: parsed.priority,
    propertyId: parsed.propertyId,
    roomId: parsed.roomId,
    page: parsed.page ?? 1,
    limit: parsed.limit ?? parsed.pageSize ?? 20,
  };
}

export function validateAcceptRepairTicketBody(
  rawBody: unknown,
  now: Date = new Date(),
): AcceptRepairTicketInput {
  const normalized = rawBody && typeof rawBody === 'object' ? rawBody : {};
  const parsed = parseZod(acceptRepairTicketSchema, normalized);
  const scheduledDate = new Date(parsed.scheduledAt);

  if (Number.isNaN(scheduledDate.getTime())) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Dữ liệu đầu vào không hợp lệ', {
      scheduledAt: ['Thời gian dự kiến sửa chữa không hợp lệ'],
    });
  }

  if (scheduledDate.getTime() < now.getTime() - SCHEDULED_AT_PAST_GRACE_MS) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Dữ liệu đầu vào không hợp lệ', {
      scheduledAt: ['Thời gian dự kiến sửa chữa không được ở quá khứ quá 5 phút'],
    });
  }

  return {
    resolutionPlan: parsed.resolutionPlan,
    scheduledAt: scheduledDate,
  };
}

export function validateCompleteRepairTicketBody(rawBody: unknown): CompleteRepairTicketInput {
  const normalized = rawBody && typeof rawBody === 'object' ? rawBody : {};
  const parsed = parseZod(completeRepairTicketSchema, normalized);
  return {
    repairCost: parsed.repairCost,
    costBearer: parsed.costBearer,
  };
}

export function validateRejectRepairCompletionBody(rawBody: unknown): RejectRepairCompletionInput {
  const normalized = rawBody && typeof rawBody === 'object' ? rawBody : {};
  const parsed = parseZod(rejectRepairCompletionSchema, normalized);
  return {
    reason: parsed.reason,
  };
}
