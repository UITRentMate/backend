import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import {
  DEFAULT_VIEWING_DURATION_MINUTES,
  VIEWING_STATUS,
  type CreateViewingAppointmentInput,
  type ConfirmViewingAppointmentInput,
  type RejectViewingAppointmentInput,
  type CancelViewingAppointmentInput,
  type ViewingAppointmentListQuery,
  type ViewingStatus,
} from './viewing-appointment.types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHONE_REGEX = /^0\d{9}$/;
const ISO_DATETIME_TZ_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

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

const createViewingAppointmentSchema = z
  .object({
    roomId: z
      .string({ error: 'Mã phòng (roomId) là bắt buộc' })
      .regex(UUID_REGEX, 'Mã phòng phải là UUID hợp lệ'),
    proposedSlots: z
      .array(
        z
          .string({ error: 'Mỗi khung giờ đề xuất phải là chuỗi thời gian hợp lệ' })
          .regex(
            ISO_DATETIME_TZ_REGEX,
            'Thời gian đề xuất phải là chuỗi ISO 8601 kèm múi giờ (ví dụ: 2026-11-20T09:00:00+07:00)',
          ),
      )
      .min(1, 'Phải cung cấp ít nhất 1 khung giờ đề xuất')
      .max(3, 'Chỉ được cung cấp tối đa 3 khung giờ đề xuất')
      .superRefine((slots, ctx) => {
        const now = Date.now();
        const slotTimes: number[] = [];

        for (let i = 0; i < slots.length; i++) {
          const slotStr = slots[i];
          const time = new Date(slotStr).getTime();
          if (Number.isNaN(time)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Khung giờ thứ ${i + 1} không phải là thời gian hợp lệ`,
              path: [i],
            });
            continue;
          }

          if (time <= now) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Khung giờ thứ ${i + 1} phải nằm trong tương lai`,
              path: [i],
            });
          }

          slotTimes.push(time);
        }

        // Kiểm tra chồng chéo giữa các khung giờ trong cùng 1 request (tối thiểu cách nhau DEFAULT_VIEWING_DURATION_MINUTES = 30 phút)
        const durationMs = DEFAULT_VIEWING_DURATION_MINUTES * 60 * 1000;
        for (let i = 0; i < slotTimes.length; i++) {
          for (let j = i + 1; j < slotTimes.length; j++) {
            if (Math.abs(slotTimes[i] - slotTimes[j]) < durationMs) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Các khung giờ đề xuất không được trùng hoặc chồng chéo nhau (phải cách nhau tối thiểu ${DEFAULT_VIEWING_DURATION_MINUTES} phút)`,
                path: [j],
              });
            }
          }
        }
      }),
    contactPhone: z
      .string()
      .trim()
      .regex(PHONE_REGEX, 'Số điện thoại liên hệ phải gồm 10 chữ số và bắt đầu bằng 0')
      .optional(),
    note: z
      .string()
      .trim()
      .max(500, 'Ghi chú không được vượt quá 500 ký tự')
      .nullable()
      .optional()
      .transform((val) => (val && val.length > 0 ? val : null)),
  })
  .strict();

const confirmViewingAppointmentSchema = z
  .object({
    selectedSlotId: z
      .string({ error: 'Mã khung giờ được chọn (selectedSlotId) là bắt buộc' })
      .regex(UUID_REGEX, 'Mã khung giờ (selectedSlotId) phải là UUID hợp lệ'),
  })
  .strict();

const rejectViewingAppointmentSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(1, 'Lý do từ chối không được để trống')
      .max(500, 'Lý do từ chối không được vượt quá 500 ký tự')
      .optional(),
    rejectionReason: z
      .string()
      .trim()
      .min(1, 'Lý do từ chối không được để trống')
      .max(500, 'Lý do từ chối không được vượt quá 500 ký tự')
      .optional(),
  })
  .strict()
  .transform((data) => {
    const finalReason = data.reason ?? data.rejectionReason;
    if (!finalReason || finalReason.trim().length === 0) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Dữ liệu đầu vào không hợp lệ', {
        reason: ['Lý do từ chối (reason) là bắt buộc và không được để trống'],
      });
    }
    return { reason: finalReason.trim() };
  });

const cancelViewingAppointmentSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(1, 'Lý do hủy không được để trống')
      .max(500, 'Lý do hủy không được vượt quá 500 ký tự')
      .optional(),
    cancellationReason: z
      .string()
      .trim()
      .min(1, 'Lý do hủy không được để trống')
      .max(500, 'Lý do hủy không được vượt quá 500 ký tự')
      .optional(),
  })
  .strict()
  .transform((data) => {
    const finalReason = data.reason ?? data.cancellationReason;
    if (!finalReason || finalReason.trim().length === 0) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Dữ liệu đầu vào không hợp lệ', {
        reason: ['Lý do hủy (reason) là bắt buộc và không được để trống'],
      });
    }
    return { reason: finalReason.trim() };
  });

export function validateAppointmentId(id: unknown): string {
  if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Định dạng mã lịch hẹn (appointmentId) không hợp lệ', {
      appointmentId: ['Mã lịch hẹn phải là UUID hợp lệ'],
    });
  }
  return id;
}

export function validateCreateViewingAppointment(body: unknown): CreateViewingAppointmentInput {
  return parseZod(createViewingAppointmentSchema, body);
}

export function validateConfirmViewingAppointment(body: unknown): ConfirmViewingAppointmentInput {
  return parseZod(confirmViewingAppointmentSchema, body);
}

export function validateRejectViewingAppointment(body: unknown): RejectViewingAppointmentInput {
  return parseZod(rejectViewingAppointmentSchema, body);
}

export function validateCancelViewingAppointment(body: unknown): CancelViewingAppointmentInput {
  return parseZod(cancelViewingAppointmentSchema, body);
}

export function validateViewingAppointmentListQuery(query: any): ViewingAppointmentListQuery {
  const pageRaw = parseInt(String(query?.page ?? '1'), 10);
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  const pageSizeRaw = parseInt(String(query?.pageSize ?? '10'), 10);
  let pageSize = Number.isInteger(pageSizeRaw) && pageSizeRaw > 0 ? pageSizeRaw : 10;
  if (pageSize > 50) pageSize = 50;

  const statusRaw = typeof query?.status === 'string' ? query.status.trim().toUpperCase() : undefined;
  let status: ViewingStatus | undefined;
  if (statusRaw && Object.values(VIEWING_STATUS).includes(statusRaw as ViewingStatus)) {
    status = statusRaw as ViewingStatus;
  }

  let roomId: string | undefined;
  if (typeof query?.roomId === 'string' && UUID_REGEX.test(query.roomId.trim())) {
    roomId = query.roomId.trim();
  }

  let fromDate: Date | undefined;
  if (typeof query?.fromDate === 'string') {
    const d = new Date(query.fromDate);
    if (!Number.isNaN(d.getTime())) {
      fromDate = d;
    }
  }

  let toDate: Date | undefined;
  if (typeof query?.toDate === 'string') {
    const d = new Date(query.toDate);
    if (!Number.isNaN(d.getTime())) {
      toDate = d;
    }
  }

  return {
    status,
    roomId,
    fromDate,
    toDate,
    page,
    pageSize,
  };
}
