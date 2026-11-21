import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { ApiError } from '../../src/common/errors/api-error';
import {
  validateCreateRoom,
  validateUpdateRoom,
  validateUpdateOperationalStatus,
  validateUpdateVisibility,
  validateLandlordRoomListQuery,
  validateRoomId,
  validatePropertyId,
  createRoomSchema,
  updateRoomSchema,
  updateOperationalStatusSchema,
  updateVisibilitySchema,
  landlordRoomListQuerySchema,
} from '../../src/modules/rooms/room-management.validation';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID_2 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('Room Management Validation Tests', () => {
  describe('validateCreateRoom', () => {
    test('chấp nhận input hợp lệ với đầy đủ các trường', () => {
      const input = {
        roomCode: 'P.301',
        floor: 3,
        areaM2: 28.5,
        maxOccupants: 2,
        monthlyRent: 4500000,
        depositRequired: 4500000,
        electricityRate: 3800,
        waterRate: 25000,
        amenityIds: [VALID_UUID],
        serviceFees: [
          { feeName: 'Vệ sinh hành lang', monthlyAmount: 50000, isRequired: true },
        ],
      };

      const result = validateCreateRoom(input);
      assert.equal(result.roomCode, 'P.301');
      assert.equal(result.floor, 3);
      assert.equal(result.areaM2, 28.5);
      assert.equal(result.maxOccupants, 2);
      assert.equal(result.monthlyRent, 4500000);
      assert.equal(result.depositRequired, 4500000);
      assert.equal(result.electricityRate, 3800);
      assert.equal(result.waterRate, 25000);
      assert.deepEqual(result.amenityIds, [VALID_UUID]);
      assert.equal(result.serviceFees?.length, 1);
      assert.equal(result.serviceFees?.[0].feeName, 'Vệ sinh hành lang');
      assert.equal(result.serviceFees?.[0].monthlyAmount, 50000);
      assert.equal(result.serviceFees?.[0].isRequired, true);
    });

    test('chấp nhận các trường tùy chọn omitted hoặc null', () => {
      const input = {
        roomCode: 'P.101',
        areaM2: 20,
        maxOccupants: 1,
        monthlyRent: 3000000,
        depositRequired: 3000000,
        electricityRate: 3500,
        waterRate: 20000,
      };

      const result = validateCreateRoom(input);
      assert.equal(result.roomCode, 'P.101');
      assert.equal(result.floor, null);
      assert.deepEqual(result.amenityIds, []);
      assert.deepEqual(result.serviceFees, []);
    });

    test('deduplicate danh sách amenityIds', () => {
      const input = {
        roomCode: 'P.102',
        areaM2: 25,
        maxOccupants: 2,
        monthlyRent: 3500000,
        depositRequired: 3500000,
        electricityRate: 3800,
        waterRate: 25000,
        amenityIds: [VALID_UUID, VALID_UUID],
      };

      const result = validateCreateRoom(input);
      assert.deepEqual(result.amenityIds, [VALID_UUID]);
    });

    test('từ chối mã phòng rỗng hoặc chỉ có khoảng trắng', () => {
      assert.throws(
        () =>
          validateCreateRoom({
            roomCode: '   ',
            areaM2: 25,
            maxOccupants: 2,
            monthlyRent: 3500000,
            depositRequired: 3500000,
            electricityRate: 3800,
            waterRate: 25000,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 400);
          assert.equal(err.code, 'VALIDATION_ERROR');
          assert.ok(err.errors?.roomCode);
          return true;
        },
      );
    });

    test('từ chối thiếu các trường bắt buộc', () => {
      assert.throws(
        () => validateCreateRoom({ roomCode: 'P.201' }),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 400);
          assert.ok(err.errors?.areaM2);
          assert.ok(err.errors?.maxOccupants);
          assert.ok(err.errors?.monthlyRent);
          assert.ok(err.errors?.depositRequired);
          assert.ok(err.errors?.electricityRate);
          assert.ok(err.errors?.waterRate);
          return true;
        },
      );
    });

    test('từ chối diện tích <= 0', () => {
      for (const invalidArea of [0, -10]) {
        assert.throws(
          () =>
            validateCreateRoom({
              roomCode: 'P.202',
              areaM2: invalidArea,
              maxOccupants: 2,
              monthlyRent: 3500000,
              depositRequired: 3500000,
              electricityRate: 3800,
              waterRate: 25000,
            }),
          (err: unknown) => {
            assert.ok(err instanceof ApiError);
            assert.equal(err.statusCode, 400);
            assert.ok(err.errors?.areaM2);
            return true;
          },
        );
      }
    });

    test('từ chối sức chứa tối đa < 1', () => {
      for (const invalidOccupants of [0, -2]) {
        assert.throws(
          () =>
            validateCreateRoom({
              roomCode: 'P.203',
              areaM2: 25,
              maxOccupants: invalidOccupants,
              monthlyRent: 3500000,
              depositRequired: 3500000,
              electricityRate: 3800,
              waterRate: 25000,
            }),
          (err: unknown) => {
            assert.ok(err instanceof ApiError);
            assert.equal(err.statusCode, 400);
            assert.ok(err.errors?.maxOccupants);
            return true;
          },
        );
      }
    });

    test('từ chối giá trị âm cho tiền thuê, tiền cọc, điện, nước', () => {
      const baseValid = {
        roomCode: 'P.204',
        areaM2: 25,
        maxOccupants: 2,
        monthlyRent: 3500000,
        depositRequired: 3500000,
        electricityRate: 3800,
        waterRate: 25000,
      };

      assert.throws(
        () => validateCreateRoom({ ...baseValid, monthlyRent: -1 }),
        (err: any) => Boolean(err instanceof ApiError && err.errors?.monthlyRent),
      );

      assert.throws(
        () => validateCreateRoom({ ...baseValid, depositRequired: -1 }),
        (err: any) => Boolean(err instanceof ApiError && err.errors?.depositRequired),
      );

      assert.throws(
        () => validateCreateRoom({ ...baseValid, electricityRate: -500 }),
        (err: any) => Boolean(err instanceof ApiError && err.errors?.electricityRate),
      );

      assert.throws(
        () => validateCreateRoom({ ...baseValid, waterRate: -1000 }),
        (err: any) => Boolean(err instanceof ApiError && err.errors?.waterRate),
      );
    });

    test('từ chối amenityId không đúng định dạng UUID', () => {
      assert.throws(
        () =>
          validateCreateRoom({
            roomCode: 'P.205',
            areaM2: 25,
            maxOccupants: 2,
            monthlyRent: 3500000,
            depositRequired: 3500000,
            electricityRate: 3800,
            waterRate: 25000,
            amenityIds: ['invalid-uuid-format'],
          }),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 400);
          assert.ok(err.errors?.['amenityIds.0']);
          return true;
        },
      );
    });

    test('từ chối serviceFee có feeName rỗng hoặc monthlyAmount âm', () => {
      const baseValid = {
        roomCode: 'P.206',
        areaM2: 25,
        maxOccupants: 2,
        monthlyRent: 3500000,
        depositRequired: 3500000,
        electricityRate: 3800,
        waterRate: 25000,
      };

      assert.throws(
        () =>
          validateCreateRoom({
            ...baseValid,
            serviceFees: [{ feeName: '  ', monthlyAmount: 50000 }],
          }),
        (err: any) => Boolean(err instanceof ApiError && err.errors?.['serviceFees.0.feeName']),
      );

      assert.throws(
        () =>
          validateCreateRoom({
            ...baseValid,
            serviceFees: [{ feeName: 'Phí gửi xe', monthlyAmount: -20000 }],
          }),
        (err: any) => Boolean(err instanceof ApiError && err.errors?.['serviceFees.0.monthlyAmount']),
      );
    });
  });

  describe('validateUpdateRoom', () => {
    test('chấp nhận payload cập nhật hợp lệ (Full Replace)', () => {
      const input = {
        roomCode: 'P.301-VIP',
        floor: 4,
        areaM2: 32,
        maxOccupants: 3,
        monthlyRent: 5000000,
        depositRequired: 5000000,
        electricityRate: 3800,
        waterRate: 25000,
        amenityIds: [VALID_UUID],
        serviceFees: [
          { feeName: 'Quản lý chung', monthlyAmount: 100000, isRequired: true },
        ],
      };

      const result = validateUpdateRoom(input);
      assert.equal(result.roomCode, 'P.301-VIP');
      assert.equal(result.floor, 4);
      assert.equal(result.areaM2, 32);
      assert.equal(result.maxOccupants, 3);
      assert.equal(result.monthlyRent, 5000000);
    });

    test('từ chối khi thiếu trường bắt buộc khi update', () => {
      assert.throws(
        () => validateUpdateRoom({ roomCode: 'P.301' }),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 400);
          return true;
        },
      );
    });
  });

  describe('validateUpdateOperationalStatus', () => {
    test('chấp nhận VACANT và MAINTENANCE', () => {
      const res1 = validateUpdateOperationalStatus({ occupancyStatus: 'VACANT' });
      assert.equal(res1.occupancyStatus, 'VACANT');

      const res2 = validateUpdateOperationalStatus({ occupancyStatus: 'MAINTENANCE' });
      assert.equal(res2.occupancyStatus, 'MAINTENANCE');
    });

    test('từ chối và ném 409 Conflict khi cố tình truyền HELD hoặc RENTED', () => {
      assert.throws(
        () => validateUpdateOperationalStatus({ occupancyStatus: 'HELD' }),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, 'INVALID_STATUS_TRANSITION');
          return true;
        },
      );

      assert.throws(
        () => validateUpdateOperationalStatus({ occupancyStatus: 'RENTED' }),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, 'INVALID_STATUS_TRANSITION');
          return true;
        },
      );
    });

    test('từ chối giá trị không thuộc enum với mã lỗi 400 VALIDATION_ERROR', () => {
      assert.throws(
        () => validateUpdateOperationalStatus({ occupancyStatus: 'ARCHIVED' }),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 400);
          assert.equal(err.code, 'VALIDATION_ERROR');
          assert.ok(err.errors?.occupancyStatus);
          return true;
        },
      );

      assert.throws(
        () => validateUpdateOperationalStatus({}),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 400);
          return true;
        },
      );
    });

    test('updateOperationalStatusSchema loại trừ HELD và RENTED', () => {
      assert.equal(updateOperationalStatusSchema.safeParse({ occupancyStatus: 'VACANT' }).success, true);
      assert.equal(updateOperationalStatusSchema.safeParse({ occupancyStatus: 'MAINTENANCE' }).success, true);
      assert.equal(updateOperationalStatusSchema.safeParse({ occupancyStatus: 'HELD' }).success, false);
      assert.equal(updateOperationalStatusSchema.safeParse({ occupancyStatus: 'RENTED' }).success, false);
    });
  });

  describe('validateUpdateVisibility', () => {
    test('chấp nhận VISIBLE và HIDDEN', () => {
      const res1 = validateUpdateVisibility({ visibilityStatus: 'VISIBLE' });
      assert.equal(res1.visibilityStatus, 'VISIBLE');

      const res2 = validateUpdateVisibility({ visibilityStatus: 'HIDDEN' });
      assert.equal(res2.visibilityStatus, 'HIDDEN');
    });

    test('từ chối giá trị khác ngoài VISIBLE và HIDDEN', () => {
      for (const invalidVis of ['DELETED', 'ARCHIVED', 'PUBLIC', '']) {
        assert.throws(
          () => validateUpdateVisibility({ visibilityStatus: invalidVis }),
          (err: unknown) => {
            assert.ok(err instanceof ApiError);
            assert.equal(err.statusCode, 400);
            assert.equal(err.code, 'VALIDATION_ERROR');
            assert.ok(err.errors?.visibilityStatus);
            return true;
          },
        );
      }
    });
  });

  describe('validateLandlordRoomListQuery', () => {
    test('áp dụng giá trị mặc định khi không truyền query', () => {
      const result = validateLandlordRoomListQuery({});
      assert.equal(result.page, 1);
      assert.equal(result.pageSize, 10);
      assert.equal(result.search, undefined);
      assert.equal(result.occupancyStatus, undefined);
      assert.equal(result.visibilityStatus, undefined);
    });

    test('chuẩn hóa tham số query hợp lệ', () => {
      const result = validateLandlordRoomListQuery({
        page: '2',
        pageSize: '25',
        search: '  P.301  ',
        occupancyStatus: 'vacant',
        visibilityStatus: 'visible',
      });

      assert.equal(result.page, 2);
      assert.equal(result.pageSize, 25);
      assert.equal(result.search, 'P.301');
      assert.equal(result.occupancyStatus, 'VACANT');
      assert.equal(result.visibilityStatus, 'VISIBLE');
    });

    test('chuẩn hóa page <= 0 thành 1 và pageSize > 50 thành 50', () => {
      const result = validateLandlordRoomListQuery({
        page: '-5',
        pageSize: '100',
      });

      assert.equal(result.page, 1);
      assert.equal(result.pageSize, 50);
    });

    test('bỏ qua occupancyStatus hoặc visibilityStatus không hợp lệ', () => {
      const result = validateLandlordRoomListQuery({
        occupancyStatus: 'INVALID_STATUS',
        visibilityStatus: 'INVALID_VISIBILITY',
      });

      assert.equal(result.occupancyStatus, undefined);
      assert.equal(result.visibilityStatus, undefined);
    });
  });

  describe('validateRoomId & validatePropertyId', () => {
    test('chấp nhận UUID hợp lệ', () => {
      assert.equal(validateRoomId(VALID_UUID), VALID_UUID);
      assert.equal(validatePropertyId(VALID_UUID), VALID_UUID);
    });

    test('từ chối UUID sai định dạng', () => {
      assert.throws(
        () => validateRoomId('not-a-valid-uuid'),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 400);
          assert.ok(err.errors?.roomId);
          return true;
        },
      );

      assert.throws(
        () => validatePropertyId('not-a-valid-uuid'),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 400);
          assert.ok(err.errors?.propertyId);
          return true;
        },
      );
    });
  });
});
