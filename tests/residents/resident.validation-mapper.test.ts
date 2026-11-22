import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ApiError } from '../../src/common/errors/api-error';
import {
  validateContractId,
  validateCreateInvitationBody,
  validateInvitationId,
  validateInvitationListQuery,
  validateUserId,
} from '../../src/modules/residents/resident.validation';
import {
  mapAcceptInvitationResponse,
  mapContractResidentsResponse,
  mapCreatedInvitationResponse,
  mapReceivedInvitationItem,
  mapRemoveResidentResponse,
} from '../../src/modules/residents/resident.mapper';

const VALID_UUID_1 = '11111111-2222-4333-8444-555555555555';
const VALID_UUID_2 = '22222222-3333-4444-8555-666666666666';
const VALID_UUID_3 = '33333333-4444-4555-8666-777777777777';
const VALID_UUID_4 = '44444444-5555-4666-8777-888888888888';

describe('Resident Validation', () => {
  test('validateCreateInvitationBody: chấp nhận email và chuẩn hóa trim + lowercase', () => {
    const parsed = validateCreateInvitationBody({
      identifier: '  User.B@RentMate.VN  ',
    });

    assert.deepEqual(parsed, {
      type: 'EMAIL',
      value: 'user.b@rentmate.vn',
    });
  });

  test('validateCreateInvitationBody: chấp nhận SĐT Việt Nam 10 chữ số bắt đầu bằng 0', () => {
    const parsed = validateCreateInvitationBody({
      identifier: ' 0901234567 ',
    });

    assert.deepEqual(parsed, {
      type: 'PHONE',
      value: '0901234567',
    });
  });

  test('validateCreateInvitationBody: từ chối UUID trong identifier với 400 VALIDATION_ERROR', () => {
    assert.throws(
      () => validateCreateInvitationBody({ identifier: VALID_UUID_1 }),
      (error: unknown) => {
        assert(error instanceof ApiError);
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, 'VALIDATION_ERROR');
        assert.ok(error.errors?.identifier?.length);
        return true;
      },
    );
  });

  test('validateCreateInvitationBody: từ chối trường thừa như userId nhờ .strict()', () => {
    assert.throws(
      () =>
        validateCreateInvitationBody({
          identifier: 'tenant.b@rentmate.vn',
          userId: VALID_UUID_1,
        }),
      (error: unknown) => {
        assert(error instanceof ApiError);
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, 'VALIDATION_ERROR');
        return true;
      },
    );
  });

  test('validateCreateInvitationBody: từ chối chuỗi rỗng và SĐT sai định dạng', () => {
    for (const badIdentifier of ['', '   ', '1901234567', '09012345', '09012345678', 'not-an-email']) {
      assert.throws(
        () => validateCreateInvitationBody({ identifier: badIdentifier }),
        (error: unknown) => {
          assert(error instanceof ApiError);
          assert.equal(error.statusCode, 400);
          assert.equal(error.code, 'VALIDATION_ERROR');
          return true;
        },
      );
    }
  });

  test('validateInvitationListQuery: trả mặc định page=1, limit=20, status=undefined', () => {
    const query = validateInvitationListQuery({});
    assert.deepEqual(query, {
      status: undefined,
      page: 1,
      limit: 20,
    });
  });

  test('validateInvitationListQuery: hỗ trợ pageSize alias và ưu tiên limit khi truyền cả hai', () => {
    const fromPageSize = validateInvitationListQuery({ page: '2', pageSize: '15', status: 'PENDING' });
    assert.deepEqual(fromPageSize, {
      status: 'PENDING',
      page: 2,
      limit: 15,
    });

    const limitWins = validateInvitationListQuery({ page: '1', limit: '10', pageSize: '30' });
    assert.deepEqual(limitWins, {
      status: undefined,
      page: 1,
      limit: 10,
    });
  });

  test('validateInvitationListQuery: từ chối status, page, limit không hợp lệ', () => {
    for (const badQuery of [
      { status: 'UNKNOWN' },
      { page: '0' },
      { page: '-1' },
      { page: 'abc' },
      { limit: '0' },
      { limit: '51' },
      { pageSize: '51' },
    ]) {
      assert.throws(
        () => validateInvitationListQuery(badQuery),
        (error: unknown) => {
          assert(error instanceof ApiError);
          assert.equal(error.statusCode, 400);
          assert.equal(error.code, 'VALIDATION_ERROR');
          return true;
        },
      );
    }
  });

  test('validateContractId, validateInvitationId, validateUserId: chấp nhận UUID hợp lệ và từ chối chuỗi sai', () => {
    assert.equal(validateContractId(` ${VALID_UUID_1} `), VALID_UUID_1);
    assert.equal(validateInvitationId(VALID_UUID_2), VALID_UUID_2);
    assert.equal(validateUserId(VALID_UUID_3), VALID_UUID_3);

    for (const fn of [validateContractId, validateInvitationId, validateUserId]) {
      assert.throws(
        () => fn('not-a-uuid'),
        (error: unknown) => {
          assert(error instanceof ApiError);
          assert.equal(error.statusCode, 400);
          assert.equal(error.code, 'VALIDATION_ERROR');
          return true;
        },
      );
    }
  });
});

describe('Resident DTO Mappers', () => {
  const sampleContractRow = {
    id: VALID_UUID_1,
    status: 'ACTIVE',
    activatedAt: new Date('2026-11-01T08:00:00.000Z'),
    tenant: {
      id: VALID_UUID_2,
      fullName: 'Nguyễn Văn Chủ HĐ',
      avatarUrl: null,
      passwordHash: 'SECRET_HASH_SHOULD_NEVER_LEAK',
      email: 'owner@rentmate.vn',
      phone: '0901111111',
    } as any,
    room: {
      id: VALID_UUID_3,
      roomCode: 'P.201',
      maxOccupants: 3,
      property: {
        id: VALID_UUID_4,
        name: 'Nhà trọ Hoa Mai',
      },
    },
    contractResidents: [
      {
        userId: '55555555-6666-4777-8888-999999999999',
        joinedAt: new Date('2026-11-10T09:30:00.000Z'),
        user: {
          id: '55555555-6666-4777-8888-999999999999',
          fullName: 'Trần Thị Ở Cùng',
          avatarUrl: 'https://res.cloudinary.com/rentmate/avatar-b.jpg',
          password_hash: 'SECRET_SNAKE_HASH',
          email: 'cores@rentmate.vn',
          phone: '0902222222',
        } as any,
      },
    ],
    residentInvitations: [
      {
        id: '66666666-7777-4888-8999-aaaaaaaaaaaa',
        status: 'PENDING',
        expiresAt: new Date('2026-11-25T12:00:00.000Z'),
        invitedUser: {
          id: '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
          fullName: 'Lê Văn Được Mời',
          avatarUrl: null,
          email: 'invited@rentmate.vn',
          phone: '0903333333',
        } as any,
        invitedBy: {
          id: VALID_UUID_2,
          fullName: 'Nguyễn Văn Chủ HĐ',
          avatarUrl: null,
        },
      },
    ],
  };

  test('mapContractResidentsResponse: đặt PRIMARY_TENANT ở vị trí 0, tính đúng sức chứa và không rò rỉ PII', () => {
    const dto = mapContractResidentsResponse(sampleContractRow, true);

    assert.equal(dto.contractId, VALID_UUID_1);
    assert.equal(dto.contractStatus, 'ACTIVE');
    assert.equal(dto.currentOccupants, 2);
    assert.equal(dto.maxOccupants, 3);
    assert.equal(dto.remainingSlots, 1);
    assert.equal(dto.residents.length, 2);
    assert.equal(dto.residents[0].residentRole, 'PRIMARY_TENANT');
    assert.equal(dto.residents[0].userId, VALID_UUID_2);
    assert.equal(dto.residents[0].joinedAt, '2026-11-01T08:00:00.000Z');
    assert.equal(dto.residents[1].residentRole, 'CO_RESIDENT');
    assert.equal(dto.residents[1].joinedAt, '2026-11-10T09:30:00.000Z');
    assert.ok(Array.isArray(dto.pendingInvitations));
    assert.equal(dto.pendingInvitations?.length, 1);

    const serialized = JSON.stringify(dto);
    assert.ok(!serialized.includes('passwordHash'));
    assert.ok(!serialized.includes('password_hash'));
    assert.ok(!serialized.includes('email'));
    assert.ok(!serialized.includes('phone'));
    assert.ok(!serialized.includes('SECRET_HASH'));
    assert.ok(!serialized.includes('owner@rentmate.vn'));
    assert.ok(!serialized.includes('0901111111'));
  });

  test('mapContractResidentsResponse: trả pendingInvitations = null khi includePendingInvitations === false', () => {
    const dto = mapContractResidentsResponse(sampleContractRow, false);
    assert.equal(dto.pendingInvitations, null);
  });

  test('các mapper còn lại trả đúng cấu trúc ISO datetime và ẩn PII', () => {
    const created = mapCreatedInvitationResponse({
      id: '66666666-7777-4888-8999-aaaaaaaaaaaa',
      contractId: VALID_UUID_1,
      status: 'PENDING',
      expiresAt: new Date('2026-11-25T12:00:00.000Z'),
      invitedUser: { id: VALID_UUID_3, fullName: 'Invitee', avatarUrl: null },
      invitedBy: { id: VALID_UUID_2, fullName: 'Inviter', avatarUrl: null },
    });
    assert.equal(created.invitationId, '66666666-7777-4888-8999-aaaaaaaaaaaa');
    assert.equal(created.status, 'PENDING');
    assert.equal(created.expiresAt, '2026-11-25T12:00:00.000Z');

    const received = mapReceivedInvitationItem({
      id: '66666666-7777-4888-8999-aaaaaaaaaaaa',
      contractId: VALID_UUID_1,
      status: 'PENDING',
      expiresAt: new Date('2026-11-25T12:00:00.000Z'),
      acceptedAt: null,
      contract: {
        room: {
          id: VALID_UUID_3,
          roomCode: 'P.201',
          maxOccupants: 3,
          property: { id: VALID_UUID_4, name: 'Hoa Mai', address: '123 Đường D1' },
        },
      },
      invitedBy: { id: VALID_UUID_2, fullName: 'Inviter', avatarUrl: null },
    });
    assert.equal(received.acceptedAt, null);
    assert.equal(received.room.property.address, '123 Đường D1');

    const accepted = mapAcceptInvitationResponse({
      invitationId: '66666666-7777-4888-8999-aaaaaaaaaaaa',
      contractId: VALID_UUID_1,
      acceptedAt: new Date('2026-11-22T12:15:00.000Z'),
      resident: {
        user: { id: VALID_UUID_3, fullName: 'Invitee', avatarUrl: null },
        joinedAt: new Date('2026-11-22T12:15:00.000Z'),
      },
      currentOccupants: 2,
      maxOccupants: 3,
    });
    assert.equal(accepted.status, 'ACCEPTED');
    assert.equal(accepted.resident.residentRole, 'CO_RESIDENT');

    const removed = mapRemoveResidentResponse({
      contractId: VALID_UUID_1,
      userId: VALID_UUID_3,
      leftAt: new Date('2026-11-22T12:30:00.000Z'),
      removalType: 'SELF_LEAVE',
      currentOccupants: 1,
      maxOccupants: 3,
    });
    assert.equal(removed.removalType, 'SELF_LEAVE');
    assert.equal(removed.leftAt, '2026-11-22T12:30:00.000Z');
  });
});
