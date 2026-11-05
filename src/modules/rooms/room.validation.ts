import { ApiError } from '../../common/errors/api-error';
import { type SearchRoomsQuery, type SortByOption } from './room.types';

export const UUID_V4_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

const VALID_SORT_OPTIONS: SortByOption[] = [
  'newest',
  'price_asc',
  'price_desc',
  'area_asc',
  'area_desc',
];

interface ParseContext {
  errors: Record<string, string[]>;
}

function addError(ctx: ParseContext, field: string, message: string): void {
  if (!ctx.errors[field]) {
    ctx.errors[field] = [];
  }
  ctx.errors[field].push(message);
}

/**
 * Kiểm tra và chuyển đổi số nguyên chặt chẽ, không dùng parseInt đơn thuần để tránh chấp nhận '1abc'.
 */
function parseStrictInteger(
  rawValue: unknown,
  fieldName: string,
  ctx: ParseContext,
  options?: { min?: number; max?: number; defaultValue?: number }
): number | undefined {
  if (rawValue === undefined) {
    return options?.defaultValue;
  }

  if (Array.isArray(rawValue)) {
    addError(ctx, fieldName, `${fieldName} không được truyền lặp lại`);
    return undefined;
  }

  if (typeof rawValue !== 'string') {
    addError(ctx, fieldName, `${fieldName} phải là chuỗi ký tự hợp lệ`);
    return undefined;
  }

  const trimmed = rawValue.trim();
  if (trimmed === '') {
    addError(ctx, fieldName, `${fieldName} không được để trống khi đã cung cấp`);
    return undefined;
  }

  // Phải khớp hoàn toàn định dạng số nguyên (có thể có dấu âm)
  if (!/^-?\d+$/.test(trimmed)) {
    addError(ctx, fieldName, `${fieldName} phải là số nguyên hợp lệ`);
    return undefined;
  }

  const num = Number(trimmed);
  if (!Number.isSafeInteger(num)) {
    addError(ctx, fieldName, `${fieldName} vượt quá giới hạn số nguyên an toàn`);
    return undefined;
  }

  if (options?.min !== undefined && num < options.min) {
    addError(ctx, fieldName, `${fieldName} phải lớn hơn hoặc bằng ${options.min}`);
    return undefined;
  }

  if (options?.max !== undefined && num > options.max) {
    addError(ctx, fieldName, `${fieldName} phải nhỏ hơn hoặc bằng ${options.max}`);
    return undefined;
  }

  return num;
}

/**
 * Kiểm tra và chuyển đổi số thực chặt chẽ (cho khoảng giá, diện tích).
 */
function parseStrictNumber(
  rawValue: unknown,
  fieldName: string,
  ctx: ParseContext,
  options?: { min?: number; max?: number }
): number | undefined {
  if (rawValue === undefined) {
    return undefined;
  }

  if (Array.isArray(rawValue)) {
    addError(ctx, fieldName, `${fieldName} không được truyền lặp lại`);
    return undefined;
  }

  if (typeof rawValue !== 'string') {
    addError(ctx, fieldName, `${fieldName} phải là chuỗi ký tự hợp lệ`);
    return undefined;
  }

  const trimmed = rawValue.trim();
  if (trimmed === '') {
    addError(ctx, fieldName, `${fieldName} không được để trống khi đã cung cấp`);
    return undefined;
  }

  // Khớp số thực không âm hoặc có âm: ^-?\d+(\.\d+)?$
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    addError(ctx, fieldName, `${fieldName} phải là số hợp lệ`);
    return undefined;
  }

  const num = Number(trimmed);
  if (!Number.isFinite(num) || Number.isNaN(num)) {
    addError(ctx, fieldName, `${fieldName} không phải là số hợp lệ`);
    return undefined;
  }

  if (options?.min !== undefined && num < options.min) {
    addError(ctx, fieldName, `${fieldName} phải lớn hơn hoặc bằng ${options.min}`);
    return undefined;
  }

  if (options?.max !== undefined && num > options.max) {
    addError(ctx, fieldName, `${fieldName} phải nhỏ hơn hoặc bằng ${options.max}`);
    return undefined;
  }

  return num;
}

/**
 * Kiểm tra chuỗi ký tự tìm kiếm tự do.
 */
function parseString(
  rawValue: unknown,
  fieldName: string,
  maxLength: number,
  ctx: ParseContext
): string | undefined {
  if (rawValue === undefined) {
    return undefined;
  }

  if (Array.isArray(rawValue)) {
    addError(ctx, fieldName, `${fieldName} không được truyền lặp lại`);
    return undefined;
  }

  if (typeof rawValue !== 'string') {
    addError(ctx, fieldName, `${fieldName} phải là chuỗi ký tự`);
    return undefined;
  }

  const trimmed = rawValue.trim();
  if (trimmed.length > maxLength) {
    addError(ctx, fieldName, `${fieldName} không được vượt quá ${maxLength} ký tự`);
    return undefined;
  }

  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse và validate danh sách amenities từ URL query CSV hoặc mảng.
 */
function parseAmenities(rawValue: unknown, ctx: ParseContext): string[] | undefined {
  if (rawValue === undefined) {
    return undefined;
  }

  let items: string[] = [];

  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (trimmed === '') {
      addError(ctx, 'amenities', 'Danh sách tiện ích không được để trống khi đã cung cấp');
      return undefined;
    }
    items = trimmed.split(',');
  } else if (Array.isArray(rawValue)) {
    for (const el of rawValue) {
      if (typeof el === 'string') {
        items.push(...el.split(','));
      } else {
        addError(ctx, 'amenities', 'Phần tử trong danh sách tiện ích phải là chuỗi');
        return undefined;
      }
    }
  } else {
    addError(ctx, 'amenities', 'Định dạng tham số amenities không hợp lệ');
    return undefined;
  }

  const validUuids: string[] = [];
  for (const rawItem of items) {
    const trimmed = rawItem.trim();
    if (trimmed === '') {
      addError(ctx, 'amenities', 'Mã tiện ích không được để trống');
      continue;
    }
    if (!UUID_V4_REGEX.test(trimmed)) {
      addError(ctx, 'amenities', `Tiện ích "${trimmed}" không phải định dạng UUID v4 hợp lệ`);
      continue;
    }
    validUuids.push(trimmed.toLowerCase());
  }

  // Deduplicate
  const uniqueUuids = Array.from(new Set(validUuids));

  if (uniqueUuids.length > 30) {
    addError(ctx, 'amenities', 'Số lượng tiện ích tìm kiếm tối đa là 30');
    return undefined;
  }

  return uniqueUuids.length > 0 ? uniqueUuids : undefined;
}

/**
 * Validate tham số sắp xếp sortBy
 */
function parseSortBy(rawValue: unknown, ctx: ParseContext): SortByOption {
  if (rawValue === undefined) {
    return 'newest';
  }

  if (Array.isArray(rawValue)) {
    addError(ctx, 'sortBy', 'sortBy không được truyền lặp lại');
    return 'newest';
  }

  if (typeof rawValue !== 'string') {
    addError(ctx, 'sortBy', 'sortBy phải là chuỗi ký tự');
    return 'newest';
  }

  const trimmed = rawValue.trim() as SortByOption;
  if (!VALID_SORT_OPTIONS.includes(trimmed)) {
    addError(
      ctx,
      'sortBy',
      `sortBy phải là một trong các giá trị: ${VALID_SORT_OPTIONS.join(', ')}`
    );
    return 'newest';
  }

  return trimmed;
}

/**
 * Hàm validate toàn diện SEARCH-01 raw query từ Express request.
 */
export function validateSearchRoomsQuery(rawQuery: Record<string, unknown>): SearchRoomsQuery {
  const ctx: ParseContext = { errors: {} };

  const keyword = parseString(rawQuery.keyword, 'keyword', 100, ctx);
  const province = parseString(rawQuery.province, 'province', 50, ctx);
  const district = parseString(rawQuery.district, 'district', 50, ctx);

  const minPrice = parseStrictNumber(rawQuery.minPrice, 'minPrice', ctx, { min: 0 });
  const maxPrice = parseStrictNumber(rawQuery.maxPrice, 'maxPrice', ctx, { min: 0 });

  const minArea = parseStrictNumber(rawQuery.minArea, 'minArea', ctx, { min: 0 });
  const maxArea = parseStrictNumber(rawQuery.maxArea, 'maxArea', ctx, { min: 0 });

  const capacity = parseStrictInteger(rawQuery.capacity, 'capacity', ctx, { min: 1, max: 50 });
  const amenities = parseAmenities(rawQuery.amenities, ctx);
  const sortBy = parseSortBy(rawQuery.sortBy, ctx);

  const page = parseStrictInteger(rawQuery.page, 'page', ctx, { min: 1, defaultValue: 1 }) ?? 1;
  const pageSize =
    parseStrictInteger(rawQuery.pageSize, 'pageSize', ctx, { min: 1, max: 50, defaultValue: 12 }) ??
    12;

  // Cross-field validation: minPrice <= maxPrice
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    addError(ctx, 'maxPrice', 'maxPrice không được nhỏ hơn minPrice');
  }

  // Cross-field validation: minArea <= maxArea
  if (minArea !== undefined && maxArea !== undefined && minArea > maxArea) {
    addError(ctx, 'maxArea', 'maxArea không được nhỏ hơn minArea');
  }

  if (Object.keys(ctx.errors).length > 0) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'Dữ liệu tìm kiếm không hợp lệ',
      ctx.errors
    );
  }

  return {
    keyword,
    province,
    district,
    minPrice,
    maxPrice,
    minArea,
    maxArea,
    capacity,
    amenities,
    sortBy,
    page,
    pageSize,
  };
}

/**
 * Validate path parameter roomId (SEARCH-02)
 */
export function validateRoomId(rawRoomId: unknown): string {
  if (typeof rawRoomId !== 'string' || !UUID_V4_REGEX.test(rawRoomId.trim())) {
    throw new ApiError(400, 'INVALID_UUID', 'Mã phòng không đúng định dạng UUID', {
      roomId: ['roomId phải là chuỗi UUID v4 hợp lệ'],
    });
  }

  return rawRoomId.trim().toLowerCase();
}
