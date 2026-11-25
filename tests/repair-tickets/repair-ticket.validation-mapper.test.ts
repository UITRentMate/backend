import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  REPAIR_ATTACHMENT_STAGE,
  REPAIR_COST_BEARER,
  REPAIR_TICKET_PRIORITY,
  REPAIR_TICKET_STATUS,
} from '../../src/common/constants/phase3-status';
import { ApiError } from '../../src/common/errors/api-error';
import { mediaService } from '../../src/modules/media/media.service';
import {
  computeAutoCloseAt,
  computeCanEscalateToComplaint,
  mapRepairTicketDetail,
  mapRepairTicketListItem,
} from '../../src/modules/repair-tickets/repair-ticket.mapper';
import {
  buildRepairAttachmentPublicId,
  cleanupUploadedRepairFiles,
  uploadRepairFilesToCloudinary,
} from '../../src/modules/repair-tickets/repair-ticket.upload';
import {
  MAX_REPAIR_COST,
  MAX_REPAIR_TICKET_LIMIT,
  MAX_REPAIR_TICKET_PAGE,
  validateAcceptRepairTicketBody,
  validateCompleteRepairTicketBody,
  validateCreateRepairTicketBody,
  validateRejectRepairCompletionBody,
  validateRepairTicketListQuery,
  validateTicketId,
} from '../../src/modules/repair-tickets/repair-ticket.validation';

const UUID_1 = '11111111-2222-4333-8444-555555555555';
const UUID_2 = '22222222-3333-4444-8555-666666666666';
const UUID_3 = '33333333-4444-4555-8666-777777777777';
const UUID_4 = '44444444-5555-4666-8777-888888888888';
const UUID_5 = '55555555-6666-4777-8888-999999999999';

const VALID_PNG_BUFFER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

const restorers: Array<() => void> = [];
afterEach(() => {
  while (restorers.length > 0) {
    restorers.pop()!();
  }
});

function createFakeMulterFile(name: string): Express.Multer.File {
  return {
    fieldname: 'attachments',
    originalname: name,
    encoding: '7bit',
    mimetype: 'image/png',
    size: VALID_PNG_BUFFER.length,
    buffer: VALID_PNG_BUFFER,
    destination: '',
    filename: name,
    path: '',
    stream: null as any,
  };
}

function assertApiError(fn: () => unknown, statusCode: number, code: string) {
  assert.throws(fn, (err: unknown) => {
    assert(err instanceof ApiError, `Expected ApiError, got ${String(err)}`);
    assert.equal(err.statusCode, statusCode);
    assert.equal(err.code, code);
    return true;
  });
}

describe('Repair Ticket Validation', () => {
  test('validateTicketId: chấp nhận UUID hợp lệ và từ chối chuỗi không phải UUID', () => {
    assert.equal(validateTicketId(`  ${UUID_1}  `), UUID_1);
    for (const invalid of ['', 'abc', '1234', null, undefined]) {
      assertApiError(() => validateTicketId(invalid), 400, 'VALIDATION_ERROR');
    }
  });

  test('validateCreateRepairTicketBody: chấp nhận roomId/propertyId, mặc định MEDIUM và chuẩn hóa ""', () => {
    const withRoom = validateCreateRepairTicketBody({
      roomId: UUID_1,
      propertyId: '',
      title: '  Máy lạnh chảy nước  ',
      description: '  Chảy nước liên tục xuống sàn phòng ngủ  ',
      priority: '',
    });
    assert.deepEqual(withRoom, {
      roomId: UUID_1,
      propertyId: undefined,
      title: 'Máy lạnh chảy nước',
      description: 'Chảy nước liên tục xuống sàn phòng ngủ',
      priority: REPAIR_TICKET_PRIORITY.MEDIUM,
    });

    const withProperty = validateCreateRepairTicketBody({
      propertyId: UUID_2,
      title: 'Hỏng đèn hành lang tầng 2',
      description: 'Đèn cầu thang tầng 2 chập chờn không sáng vào ban đêm',
      priority: 'URGENT',
    });
    assert.deepEqual(withProperty, {
      roomId: undefined,
      propertyId: UUID_2,
      title: 'Hỏng đèn hành lang tầng 2',
      description: 'Đèn cầu thang tầng 2 chập chờn không sáng vào ban đêm',
      priority: REPAIR_TICKET_PRIORITY.URGENT,
    });

    const withBoth = validateCreateRepairTicketBody({
      roomId: UUID_1,
      propertyId: UUID_2,
      title: 'Vỡ ống nước bồn rửa',
      description: 'Ống xả dưới bồn rửa chén bị nứt rỉ nước ra ngoài',
      priority: 'HIGH',
    });
    assert.equal(withBoth.roomId, UUID_1);
    assert.equal(withBoth.propertyId, UUID_2);
  });

  test('validateCreateRepairTicketBody: từ chối thiếu cả roomId & propertyId, sai độ dài, sai enum', () => {
    assertApiError(
      () =>
        validateCreateRepairTicketBody({
          title: 'Máy lạnh hư',
          description: 'Máy lạnh không chạy từ tối hôm qua',
        }),
      400,
      'VALIDATION_ERROR',
    );
    assertApiError(
      () =>
        validateCreateRepairTicketBody({
          roomId: UUID_1,
          title: 'Ngắn',
          description: 'Mô tả đủ dài trên mười ký tự',
        }),
      400,
      'VALIDATION_ERROR',
    );
    assertApiError(
      () =>
        validateCreateRepairTicketBody({
          roomId: UUID_1,
          title: 'A'.repeat(201),
          description: 'Mô tả đủ dài trên mười ký tự',
        }),
      400,
      'VALIDATION_ERROR',
    );
    assertApiError(
      () =>
        validateCreateRepairTicketBody({
          roomId: UUID_1,
          title: 'Tiêu đề hợp lệ',
          description: 'Quá ngắn',
        }),
      400,
      'VALIDATION_ERROR',
    );
    assertApiError(
      () =>
        validateCreateRepairTicketBody({
          roomId: UUID_1,
          title: 'Tiêu đề hợp lệ',
          description: 'A'.repeat(2001),
        }),
      400,
      'VALIDATION_ERROR',
    );
    assertApiError(
      () =>
        validateCreateRepairTicketBody({
          roomId: UUID_1,
          title: 'Tiêu đề hợp lệ',
          description: 'Mô tả đủ dài trên mười ký tự',
          priority: 'CRITICAL',
        }),
      400,
      'VALIDATION_ERROR',
    );
  });

  test('validateRepairTicketListQuery: mặc định, alias pageSize và giới hạn biên', () => {
    assert.deepEqual(validateRepairTicketListQuery({}), {
      status: undefined,
      priority: undefined,
      propertyId: undefined,
      roomId: undefined,
      page: 1,
      limit: 20,
    });

    const fromPageSize = validateRepairTicketListQuery({
      status: 'OPEN',
      priority: 'HIGH',
      propertyId: UUID_1,
      roomId: UUID_2,
      page: String(MAX_REPAIR_TICKET_PAGE),
      pageSize: String(MAX_REPAIR_TICKET_LIMIT),
    });
    assert.equal(fromPageSize.page, MAX_REPAIR_TICKET_PAGE);
    assert.equal(fromPageSize.limit, MAX_REPAIR_TICKET_LIMIT);
    assert.equal(fromPageSize.status, REPAIR_TICKET_STATUS.OPEN);
    assert.equal(fromPageSize.priority, REPAIR_TICKET_PRIORITY.HIGH);

    const limitWins = validateRepairTicketListQuery({ limit: '10', pageSize: '30' });
    assert.equal(limitWins.limit, 10);

    for (const bad of [
      { page: '0' },
      { page: String(MAX_REPAIR_TICKET_PAGE + 1) },
      { limit: '0' },
      { limit: String(MAX_REPAIR_TICKET_LIMIT + 1) },
      { pageSize: String(MAX_REPAIR_TICKET_LIMIT + 1) },
      { propertyId: 'not-uuid' },
      { roomId: 'not-uuid' },
      { status: 'DONE' },
      { priority: 'CRITICAL' },
    ]) {
      assertApiError(() => validateRepairTicketListQuery(bad), 400, 'VALIDATION_ERROR');
    }
  });

  test('validateAcceptRepairTicketBody (Q5): chấp nhận trong cửa sổ >= now - 5 phút, từ chối < now - 5 phút, thiếu TZ hoặc trường thừa', () => {
    const now = new Date('2026-11-24T10:00:00.000Z');
    const fourMinutesAgo = new Date(now.getTime() - 4 * 60 * 1000).toISOString();
    const future = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    const okPastGrace = validateAcceptRepairTicketBody(
      {
        resolutionPlan: '  Kiểm tra và thay van khóa nước  ',
        scheduledAt: fourMinutesAgo,
      },
      now,
    );
    assert.equal(okPastGrace.resolutionPlan, 'Kiểm tra và thay van khóa nước');
    assert.equal(okPastGrace.scheduledAt.toISOString(), fourMinutesAgo);

    const okFuture = validateAcceptRepairTicketBody(
      {
        resolutionPlan: 'Thợ đến kiểm tra vào chiều mai',
        scheduledAt: future,
      },
      now,
    );
    assert.equal(okFuture.scheduledAt.toISOString(), future);

    const sixMinutesAgo = new Date(now.getTime() - 6 * 60 * 1000).toISOString();
    assertApiError(
      () =>
        validateAcceptRepairTicketBody(
          { resolutionPlan: 'Kế hoạch hợp lệ', scheduledAt: sixMinutesAgo },
          now,
        ),
      400,
      'VALIDATION_ERROR',
    );
    assertApiError(
      () =>
        validateAcceptRepairTicketBody(
          { resolutionPlan: 'Kế hoạch hợp lệ', scheduledAt: '2026-11-25T09:00:00' },
          now,
        ),
      400,
      'VALIDATION_ERROR',
    );
    assertApiError(
      () =>
        validateAcceptRepairTicketBody(
          { resolutionPlan: 'Kế hoạch hợp lệ', scheduledAt: '2027-02-30T09:00:00.000Z' },
          now,
        ),
      400,
      'VALIDATION_ERROR',
    );
    assertApiError(
      () =>
        validateAcceptRepairTicketBody(
          { resolutionPlan: 'Kế hoạch hợp lệ', scheduledAt: future, extra: true },
          now,
        ),
      400,
      'VALIDATION_ERROR',
    );
  });

  test('validateCompleteRepairTicketBody (Q3): bắt buộc repairCost & costBearer đi cặp và kiểm tra biên số', () => {
    assert.deepEqual(validateCompleteRepairTicketBody({ repairCost: '', costBearer: '' }), {
      repairCost: undefined,
      costBearer: undefined,
    });

    assert.deepEqual(
      validateCompleteRepairTicketBody({ repairCost: '350000', costBearer: 'LANDLORD' }),
      { repairCost: 350000, costBearer: REPAIR_COST_BEARER.LANDLORD },
    );

    assert.deepEqual(
      validateCompleteRepairTicketBody({ repairCost: '0', costBearer: 'TENANT' }),
      { repairCost: 0, costBearer: REPAIR_COST_BEARER.TENANT },
    );

    for (const bad of [
      { repairCost: '0' },
      { repairCost: '100000' },
      { costBearer: 'LANDLORD' },
      { repairCost: '-1', costBearer: 'LANDLORD' },
      { repairCost: String(MAX_REPAIR_COST + 1), costBearer: 'LANDLORD' },
      { repairCost: '100.123', costBearer: 'LANDLORD' },
      { repairCost: 'NaN', costBearer: 'LANDLORD' },
      { repairCost: '1000', costBearer: 'ADMIN' },
    ]) {
      assertApiError(() => validateCompleteRepairTicketBody(bad), 400, 'VALIDATION_ERROR');
    }
  });

  test('validateRejectRepairCompletionBody: reason 10..1000 ký tự và từ chối field thừa', () => {
    const ok = validateRejectRepairCompletionBody({
      reason: '  Sau khi sửa máy vẫn còn rò nước ở góc phải  ',
    });
    assert.equal(ok.reason, 'Sau khi sửa máy vẫn còn rò nước ở góc phải');

    assertApiError(() => validateRejectRepairCompletionBody({ reason: 'Quá ngắn' }), 400, 'VALIDATION_ERROR');
    assertApiError(
      () => validateRejectRepairCompletionBody({ reason: 'A'.repeat(1001) }),
      400,
      'VALIDATION_ERROR',
    );
    assertApiError(
      () =>
        validateRejectRepairCompletionBody({
          reason: 'Sau khi sửa máy vẫn còn rò nước ở góc phải',
          extraField: 'unexpected',
        }),
      400,
      'VALIDATION_ERROR',
    );
  });
});

describe('Repair Ticket Upload Rollback & Mapper', () => {
  test('uploadRepairFilesToCloudinary: rollback sạch các ảnh đã upload nếu file #3 thất bại', async () => {
    const uploadedCalls: string[] = [];
    const deletedCalls: string[] = [];

    const originalUpload = mediaService.uploadStream.bind(mediaService);
    const originalDelete = mediaService.deleteResource.bind(mediaService);
    mediaService.uploadStream = async (_buffer, options) => {
      uploadedCalls.push(options.publicId ?? '');
      if (uploadedCalls.length === 3) {
        throw new Error('Simulated Cloudinary outage');
      }
      return {
        secureUrl: `https://res.cloudinary.com/demo/image/upload/v1/${options.publicId}.webp`,
        publicId: options.publicId ?? '',
      };
    };
    mediaService.deleteResource = async (publicId) => {
      deletedCalls.push(publicId);
      return true;
    };
    restorers.push(() => {
      mediaService.uploadStream = originalUpload;
      mediaService.deleteResource = originalDelete;
    });

    await assert.rejects(
      () =>
        uploadRepairFilesToCloudinary(
          [
            createFakeMulterFile('a.png'),
            createFakeMulterFile('b.png'),
            createFakeMulterFile('c.png'),
          ],
          {
            propertyId: UUID_1,
            ticketId: UUID_2,
            stage: REPAIR_ATTACHMENT_STAGE.INITIAL,
          },
        ),
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.statusCode, 502);
        assert.equal(err.code, 'CLOUDINARY_UPLOAD_FAILED');
        return true;
      },
    );

    assert.equal(uploadedCalls.length, 3);
    assert.deepEqual(deletedCalls, uploadedCalls.slice(0, 2));
    assert.ok(
      buildRepairAttachmentPublicId(UUID_1, UUID_2, REPAIR_ATTACHMENT_STAGE.INITIAL, UUID_3).startsWith(
        `rentmate/repairs/${UUID_1}/${UUID_2}/initial_`,
      ),
    );
    await cleanupUploadedRepairFiles([]);
  });

  test('computeCanEscalateToComplaint & computeAutoCloseAt: ranh giới 72h và 5 ngày chính xác', () => {
    const createdAt = new Date('2026-11-20T00:00:00.000Z');
    const before72h = new Date(createdAt.getTime() + 72 * 60 * 60 * 1000 - 1000);
    const exact72h = new Date(createdAt.getTime() + 72 * 60 * 60 * 1000);

    assert.equal(computeCanEscalateToComplaint(REPAIR_TICKET_STATUS.OPEN, createdAt, before72h), false);
    assert.equal(computeCanEscalateToComplaint(REPAIR_TICKET_STATUS.OPEN, createdAt, exact72h), true);
    assert.equal(computeCanEscalateToComplaint(REPAIR_TICKET_STATUS.IN_PROGRESS, createdAt, exact72h), false);

    const completedAt = new Date('2026-11-21T12:00:00.000Z');
    assert.equal(
      computeAutoCloseAt(REPAIR_TICKET_STATUS.AWAITING_CONFIRMATION, completedAt),
      '2026-11-26T12:00:00.000Z',
    );
    assert.equal(computeAutoCloseAt(REPAIR_TICKET_STATUS.CLOSED, completedAt), null);
  });

  test('mapRepairTicketListItem & mapRepairTicketDetail: nhóm ảnh theo stage, reopenHistory, zero PII', () => {
    const now = new Date('2026-11-24T12:00:00.000Z');
    const createdAt = new Date('2026-11-20T00:00:00.000Z');
    const completedAt = new Date('2026-11-22T06:00:00.000Z');

    const listDto = mapRepairTicketListItem(
      {
        id: UUID_1,
        title: 'Hỏng vòi sen',
        priority: REPAIR_TICKET_PRIORITY.HIGH,
        status: REPAIR_TICKET_STATUS.AWAITING_CONFIRMATION,
        scheduledAt: new Date('2026-11-21T09:00:00.000Z'),
        completedAt,
        closedAt: null,
        createdAt,
        property: { id: UUID_2, name: 'Nhà trọ Hoa Mai', address: '123 Đường D1' },
        room: { id: UUID_3, roomCode: 'P.201' },
        createdBy: { id: UUID_4, fullName: 'Nguyễn Văn A', avatarUrl: null },
        attachments: [
          { id: 'att-1', fileUrl: 'https://cdn.test/comp.webp', stage: 'COMPLETION' },
          { id: 'att-2', fileUrl: 'https://cdn.test/init.webp', stage: 'INITIAL' },
        ],
      },
      now,
    );

    assert.equal(listDto.canEscalateToComplaint, false);
    assert.equal(listDto.autoCloseAt, '2026-11-27T06:00:00.000Z');
    assert.equal(listDto.attachmentCount, 2);
    assert.equal(listDto.thumbnailUrl, 'https://cdn.test/init.webp');

    const detailDto = mapRepairTicketDetail(
      {
        id: UUID_1,
        propertyId: UUID_2,
        roomId: UUID_3,
        createdById: UUID_4,
        title: 'Hỏng vòi sen',
        description: 'Vòi sen bị rỉ nước mạnh tại khớp nối',
        priority: REPAIR_TICKET_PRIORITY.HIGH,
        status: REPAIR_TICKET_STATUS.AWAITING_CONFIRMATION,
        resolutionPlan: 'Thay dây sen và gioăng cao su',
        repairCost: { toNumber: () => 250000 },
        costBearer: REPAIR_COST_BEARER.LANDLORD,
        scheduledAt: new Date('2026-11-21T09:00:00.000Z'),
        completedAt,
        closedAt: null,
        createdAt,
        property: { id: UUID_2, name: 'Nhà trọ Hoa Mai', address: '123 Đường D1' },
        room: { id: UUID_3, roomCode: 'P.201' },
        createdBy: { id: UUID_4, fullName: 'Nguyễn Văn A', avatarUrl: null },
        attachments: [
          {
            id: UUID_5,
            fileUrl: 'https://cdn.test/init.webp',
            stage: REPAIR_ATTACHMENT_STAGE.INITIAL,
            reason: null,
            uploadedBy: { id: UUID_4, fullName: 'Nguyễn Văn A', avatarUrl: null },
          },
          {
            id: 'att-comp',
            fileUrl: 'https://cdn.test/comp.webp',
            stage: REPAIR_ATTACHMENT_STAGE.COMPLETION,
            reason: null,
            uploadedBy: { id: UUID_5, fullName: 'Chủ trọ', avatarUrl: null },
          },
        ],
      },
      [
        {
          actorId: UUID_4,
          newData: { reason: 'Vẫn còn rỉ nước nhẹ', attachmentCount: 0 },
          createdAt: new Date('2026-11-22T02:00:00.000Z'),
        },
        {
          actorId: UUID_4,
          newData: { reason: 'Áp lực nước vẫn yếu sau lần sửa 2', attachmentCount: 1 },
          createdAt: new Date('2026-11-22T04:00:00.000Z'),
        },
      ],
      now,
    );

    assert.equal(detailDto.repairCost, 250000);
    assert.equal(detailDto.autoCloseAt, '2026-11-27T06:00:00.000Z');
    assert.equal(detailDto.attachmentsByStage.INITIAL.length, 1);
    assert.equal(detailDto.attachmentsByStage.COMPLETION.length, 1);
    assert.equal(detailDto.attachmentsByStage.REOPEN_EVIDENCE.length, 0);
    assert.equal(detailDto.latestRejectionReason, 'Áp lực nước vẫn yếu sau lần sửa 2');
    assert.equal(detailDto.reopenHistory.length, 2);

    const serialized = JSON.stringify(detailDto);
    assert.ok(!serialized.includes('passwordHash'));
    assert.ok(!serialized.includes('email'));
    assert.ok(!serialized.includes('phone'));
  });
});
