import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../../src/common/errors/api-error';
import {
  validateCreateProperty,
  validateUpdateProperty,
  validatePropertyListQuery,
  validatePropertyId,
} from '../../src/modules/properties/property.validation';

test('validateCreateProperty accepts valid input', () => {
  const input = {
    name: 'Khu trọ Hòa Bình',
    address: '123 Đỗ Xuân Hợp, Q9',
    houseRules: 'Không ồn ào sau 23h',
    coverImageUrl: 'https://images.unsplash.com/photo-1',
    amenityIds: ['550e8400-e29b-41d4-a716-446655440000'],
  };

  const result = validateCreateProperty(input);
  assert.equal(result.name, input.name);
  assert.equal(result.address, input.address);
  assert.equal(result.houseRules, input.houseRules);
  assert.equal(result.coverImageUrl, input.coverImageUrl);
  assert.deepEqual(result.amenityIds, input.amenityIds);
});

test('validateCreateProperty accepts optional fields omitted or null', () => {
  const input = {
    name: 'Khu trọ Hòa Bình',
    address: '123 Đỗ Xuân Hợp, Q9',
  };

  const result = validateCreateProperty(input);
  assert.equal(result.name, input.name);
  assert.equal(result.address, input.address);
  assert.equal(result.houseRules, null);
  assert.equal(result.coverImageUrl, null);
  assert.deepEqual(result.amenityIds, []);
});

test('validateCreateProperty rejects missing name or address', () => {
  assert.throws(
    () => validateCreateProperty({ name: '', address: '' }),
    (err: any) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, 'VALIDATION_ERROR');
      assert.ok(err.errors?.name);
      assert.ok(err.errors?.address);
      return true;
    },
  );
});

test('validateCreateProperty rejects invalid amenity UUID', () => {
  assert.throws(
    () =>
      validateCreateProperty({
        name: 'Khu trọ Hòa Bình',
        address: '123 Đỗ Xuân Hợp',
        amenityIds: ['not-a-uuid'],
      }),
    (err: any) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.statusCode, 400);
      assert.ok(err.errors?.['amenityIds.0']);
      return true;
    },
  );
});

test('validateCreateProperty deduplicates amenity IDs and normalizes empty coverImageUrl', () => {
  const validUuid = '550e8400-e29b-41d4-a716-446655440000';
  const input = {
    name: 'Khu trọ Hòa Bình',
    address: '123 Đỗ Xuân Hợp, Q9',
    coverImageUrl: '   ',
    amenityIds: [validUuid, validUuid],
  };

  const result = validateCreateProperty(input);
  assert.equal(result.coverImageUrl, null);
  assert.deepEqual(result.amenityIds, [validUuid]);
});

test('validateUpdateProperty accepts valid update payload and normalizes fields', () => {
  const validUuid = '550e8400-e29b-41d4-a716-446655440000';
  const input = {
    name: 'Khu trọ Hòa Bình Cập Nhật',
    address: '456 Đỗ Xuân Hợp, Q9',
    houseRules: 'Nội quy mới',
    coverImageUrl: '',
    amenityIds: [validUuid, validUuid],
  };

  const result = validateUpdateProperty(input);
  assert.equal(result.name, 'Khu trọ Hòa Bình Cập Nhật');
  assert.equal(result.address, '456 Đỗ Xuân Hợp, Q9');
  assert.equal(result.houseRules, 'Nội quy mới');
  assert.equal(result.coverImageUrl, null);
  assert.deepEqual(result.amenityIds, [validUuid]);
});

test('validateUpdateProperty rejects missing name or address', () => {
  assert.throws(
    () => validateUpdateProperty({ name: '   ', address: '' }),
    (err: any) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, 'VALIDATION_ERROR');
      return true;
    },
  );
});

test('validatePropertyListQuery normalizes page and pageSize', () => {
  const result = validatePropertyListQuery({
    page: '-1',
    pageSize: '100',
    search: '  Hòa Bình  ',
    status: 'ACTIVE',
  });

  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 50); // Capped at max 50
  assert.equal(result.search, 'Hòa Bình');
  assert.equal(result.status, 'ACTIVE');
});

test('validatePropertyId validates UUID format', () => {
  const validUuid = '550e8400-e29b-41d4-a716-446655440000';
  assert.equal(validatePropertyId(validUuid), validUuid);

  assert.throws(
    () => validatePropertyId('invalid-uuid'),
    (err: any) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, 'VALIDATION_ERROR');
      return true;
    },
  );
});
