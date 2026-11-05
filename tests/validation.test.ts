import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateSearchRoomsQuery, validateRoomId } from '../src/modules/rooms/room.validation';
import { ApiError } from '../src/common/errors/api-error';

describe('SEARCH-01 Query Validation', () => {
  test('Tham số mặc định khi không truyền query: page=1, pageSize=12, sortBy=newest', () => {
    const result = validateSearchRoomsQuery({});
    assert.equal(result.page, 1);
    assert.equal(result.pageSize, 12);
    assert.equal(result.sortBy, 'newest');
    assert.equal(result.keyword, undefined);
    assert.equal(result.minPrice, undefined);
    assert.equal(result.maxPrice, undefined);
  });

  test('Truyền đầy đủ các tham số hợp lệ', () => {
    const result = validateSearchRoomsQuery({
      keyword: '  CMT8  ',
      province: 'TP.HCM',
      district: 'Quận 10',
      minPrice: '3000000',
      maxPrice: '5000000',
      minArea: '20.5',
      maxArea: '40',
      capacity: '2',
      amenities: 'e1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c,e4a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5f',
      sortBy: 'price_asc',
      page: '2',
      pageSize: '24',
    });

    assert.equal(result.keyword, 'CMT8');
    assert.equal(result.province, 'TP.HCM');
    assert.equal(result.district, 'Quận 10');
    assert.equal(result.minPrice, 3000000);
    assert.equal(result.maxPrice, 5000000);
    assert.equal(result.minArea, 20.5);
    assert.equal(result.maxArea, 40);
    assert.equal(result.capacity, 2);
    assert.deepEqual(result.amenities, [
      'e1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c',
      'e4a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5f',
    ]);
    assert.equal(result.sortBy, 'price_asc');
    assert.equal(result.page, 2);
    assert.equal(result.pageSize, 24);
  });

  test('Từ chối page <= 0 hoặc không phải số nguyên', () => {
    const invalidPages = ['0', '-1', '1.5', '1abc', 'abc'];
    for (const val of invalidPages) {
      assert.throws(
        () => validateSearchRoomsQuery({ page: val }),
        (err: unknown) => {
          assert(err instanceof ApiError);
          assert.equal(err.statusCode, 400);
          assert.equal(err.code, 'VALIDATION_ERROR');
          assert(err.errors?.page !== undefined);
          return true;
        }
      );
    }
  });

  test('Từ chối pageSize <= 0 hoặc pageSize > 50', () => {
    const invalidPageSizes = ['0', '-5', '51', '99', '2.5'];
    for (const val of invalidPageSizes) {
      assert.throws(
        () => validateSearchRoomsQuery({ pageSize: val }),
        (err: unknown) => {
          assert(err instanceof ApiError);
          assert.equal(err.statusCode, 400);
          assert(err.errors?.pageSize !== undefined);
          return true;
        }
      );
    }
  });

  test('Từ chối số âm cho minPrice, maxPrice, minArea, maxArea', () => {
    assert.throws(
      () => validateSearchRoomsQuery({ minPrice: '-1' }),
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert(err.errors?.minPrice !== undefined);
        return true;
      }
    );

    assert.throws(
      () => validateSearchRoomsQuery({ minArea: '-5' }),
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert(err.errors?.minArea !== undefined);
        return true;
      }
    );
  });

  test('Chấp nhận giá trị 0 cho minPrice (không bị nuốt bởi truthiness)', () => {
    const result = validateSearchRoomsQuery({ minPrice: '0' });
    assert.equal(result.minPrice, 0);
  });

  test('Từ chối khoảng min > max (cross-field validation)', () => {
    assert.throws(
      () => validateSearchRoomsQuery({ minPrice: '5000000', maxPrice: '3000000' }),
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert(err.errors?.maxPrice !== undefined);
        assert.equal(err.errors.maxPrice[0], 'maxPrice không được nhỏ hơn minPrice');
        return true;
      }
    );

    assert.throws(
      () => validateSearchRoomsQuery({ minArea: '50', maxArea: '30' }),
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert(err.errors?.maxArea !== undefined);
        assert.equal(err.errors.maxArea[0], 'maxArea không được nhỏ hơn minArea');
        return true;
      }
    );
  });

  test('Từ chối sortBy không thuộc enum', () => {
    assert.throws(
      () => validateSearchRoomsQuery({ sortBy: 'hacked_field' }),
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert(err.errors?.sortBy !== undefined);
        return true;
      }
    );
  });

  test('Từ chối amenities chứa UUID sai hoặc UUID v1', () => {
    // UUID v1 (ký tự phiên bản là 1 thay vì 4)
    assert.throws(
      () =>
        validateSearchRoomsQuery({
          amenities: 'e1a2b3c4-d5e6-1f7a-8b9c-0d1e2f3a4b5c',
        }),
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert(err.errors?.amenities !== undefined);
        return true;
      }
    );

    // Chuỗi ngẫu nhiên
    assert.throws(
      () =>
        validateSearchRoomsQuery({
          amenities: 'not-a-uuid',
        }),
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert(err.errors?.amenities !== undefined);
        return true;
      }
    );
  });

  test('Deduplicate tiện ích trùng lặp trong amenities', () => {
    const uuid = 'e1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c';
    const result = validateSearchRoomsQuery({
      amenities: `${uuid},${uuid}`,
    });
    assert.deepEqual(result.amenities, [uuid]);
  });
});

describe('SEARCH-02 Path Validation', () => {
  test('Chấp nhận roomId là UUID v4 hợp lệ', () => {
    const validUuid = '7b8f9e61-3d2a-4a5b-b1c2-d3e4f5a6b7c8';
    const result = validateRoomId(validUuid);
    assert.equal(result, validUuid);
  });

  test('Từ chối roomId không phải chuỗi hoặc không phải UUID v4', () => {
    const invalidIds = ['not-a-uuid', '12345', '7b8f9e61-3d2a-1a5b-b1c2-d3e4f5a6b7c8', ''];
    for (const val of invalidIds) {
      assert.throws(
        () => validateRoomId(val),
        (err: unknown) => {
          assert(err instanceof ApiError);
          assert.equal(err.statusCode, 400);
          assert.equal(err.code, 'INVALID_UUID');
          assert(err.errors?.roomId !== undefined);
          return true;
        }
      );
    }
  });
});
