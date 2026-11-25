import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
  NOTIFICATION_EVENT_TYPE,
  REPAIR_COST_BEARER,
  REPAIR_TICKET_PRIORITY,
  REPAIR_TICKET_STATUS,
} from '../../src/common/constants/phase3-status';
import { ApiError } from '../../src/common/errors/api-error';
import type { CurrentUser } from '../../src/common/middleware/require-role';
import { prisma } from '../../src/infrastructure/database/prisma';
import { mediaService } from '../../src/modules/media/media.service';
import { RepairTicketRepository } from '../../src/modules/repair-tickets/repair-ticket.repository';
import {
  autoCloseStaleRepairTickets,
  RepairTicketService,
} from '../../src/modules/repair-tickets/repair-ticket.service';
import type {
  RepairTicketDetailRow,
  RepairTicketMutationRow,
} from '../../src/modules/repair-tickets/repair-ticket.types';

const TICKET_ID = '11111111-2222-4333-8444-555555555555';
const PROP_ID = '22222222-3333-4444-8555-666666666666';
const OTHER_PROP_ID = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
const ROOM_ID = '33333333-4444-4555-8666-777777777777';
const CONTRACT_ID = '44444444-5555-4666-8777-888888888888';
const LANDLORD_ID = '55555555-6666-4777-8888-999999999999';
const PRIMARY_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const CO_RESIDENT_B_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const CO_RESIDENT_C_ID = '88888888-9999-4aaa-8bbb-cccccccccccc';
const OTHER_TENANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const landlordUser: CurrentUser = {
  id: LANDLORD_ID,
  role: 'LANDLORD',
  accountStatus: 'ACTIVE',
  fullName: 'Chủ trọ',
};
const primaryUser: CurrentUser = {
  id: PRIMARY_ID,
  role: 'TENANT',
  accountStatus: 'ACTIVE',
  fullName: 'Người thuê A',
};
const coResidentBUser: CurrentUser = {
  id: CO_RESIDENT_B_ID,
  role: 'TENANT',
  accountStatus: 'ACTIVE',
  fullName: 'Người ở cùng B',
};
const otherTenantUser: CurrentUser = {
  id: OTHER_TENANT_ID,
  role: 'TENANT',
  accountStatus: 'ACTIVE',
  fullName: 'Người thuê phòng khác',
};

const VALID_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

function fakeFile(name = 'photo.png'): Express.Multer.File {
  return {
    fieldname: 'attachments',
    originalname: name,
    encoding: '7bit',
    mimetype: 'image/png',
    size: VALID_PNG.length,
    buffer: VALID_PNG,
    destination: '',
    filename: name,
    path: '',
    stream: null as any,
  };
}

const restorers: Array<() => void> = [];
afterEach(() => {
  while (restorers.length > 0) {
    restorers.pop()!();
  }
});

function stubRepo<K extends keyof typeof RepairTicketRepository>(
  method: K,
  impl: (typeof RepairTicketRepository)[K],
) {
  const original = RepairTicketRepository[method];
  (RepairTicketRepository as Record<string, unknown>)[method] = impl;
  restorers.push(() => {
    (RepairTicketRepository as Record<string, unknown>)[method] = original;
  });
}

function stubMedia() {
  const uploaded: string[] = [];
  const deleted: string[] = [];
  const originalUpload = mediaService.uploadStream.bind(mediaService);
  const originalDelete = mediaService.deleteResource.bind(mediaService);

  mediaService.uploadStream = async (_buf, options) => {
    const publicId = options.publicId ?? `pub-${uploaded.length + 1}`;
    uploaded.push(publicId);
    return {
      secureUrl: `https://res.cloudinary.com/demo/image/upload/v1/${publicId}.webp`,
      publicId,
    };
  };
  mediaService.deleteResource = async (publicId) => {
    deleted.push(publicId);
    return true;
  };
  restorers.push(() => {
    mediaService.uploadStream = originalUpload;
    mediaService.deleteResource = originalDelete;
  });

  return { uploaded, deleted };
}

function stubTransaction() {
  const notifications: Array<Record<string, any>> = [];
  const auditLogs: Array<Record<string, any>> = [];
  let commits = 0;

  const tx = {
    notification: {
      create: async ({ data }: { data: Record<string, any> }) => {
        notifications.push(data);
        return { id: `notif-${notifications.length}`, ...data };
      },
      createMany: async ({ data }: { data: Array<Record<string, any>> }) => {
        notifications.push(...data);
        return { count: data.length };
      },
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, any> }) => {
        auditLogs.push(data);
        return { id: `audit-${auditLogs.length}`, ...data };
      },
    },
  };

  const original = prisma.$transaction;
  (prisma as unknown as { $transaction: unknown }).$transaction = async (
    work: (client: unknown) => Promise<unknown>,
  ) => {
    const result = await work(tx);
    commits += 1;
    return result;
  };
  restorers.push(() => {
    (prisma as unknown as { $transaction: unknown }).$transaction = original;
  });

  return { tx, notifications, auditLogs, committedCount: () => commits };
}

function makeMutationRow(overrides: Partial<RepairTicketMutationRow> = {}): RepairTicketMutationRow {
  return {
    id: TICKET_ID,
    propertyId: PROP_ID,
    roomId: ROOM_ID,
    createdById: PRIMARY_ID,
    title: 'Máy lạnh chảy nước',
    status: REPAIR_TICKET_STATUS.AWAITING_CONFIRMATION,
    resolutionPlan: 'Vệ sinh dàn lạnh',
    repairCost: 350000,
    costBearer: REPAIR_COST_BEARER.LANDLORD,
    scheduledAt: new Date('2026-11-21T09:00:00.000Z'),
    completedAt: new Date(Date.now() - 60 * 60 * 1000),
    closedAt: null,
    createdAt: new Date('2026-11-20T09:00:00.000Z'),
    property: { id: PROP_ID, landlordId: LANDLORD_ID },
    ...overrides,
  };
}

function makeDetailRow(overrides: Partial<RepairTicketDetailRow> = {}): RepairTicketDetailRow {
  return {
    id: TICKET_ID,
    propertyId: PROP_ID,
    roomId: ROOM_ID,
    createdById: PRIMARY_ID,
    title: 'Máy lạnh chảy nước',
    description: 'Chảy nước xuống tường phòng ngủ',
    priority: REPAIR_TICKET_PRIORITY.HIGH,
    status: REPAIR_TICKET_STATUS.AWAITING_CONFIRMATION,
    resolutionPlan: 'Vệ sinh dàn lạnh',
    repairCost: 350000,
    costBearer: REPAIR_COST_BEARER.LANDLORD,
    scheduledAt: new Date('2026-11-21T09:00:00.000Z'),
    completedAt: new Date('2026-11-22T09:00:00.000Z'),
    closedAt: null,
    createdAt: new Date('2026-11-20T09:00:00.000Z'),
    property: { id: PROP_ID, name: 'Nhà trọ Hoa Mai', address: '123 Đường D1' },
    room: { id: ROOM_ID, roomCode: 'P.201' },
    createdBy: { id: PRIMARY_ID, fullName: 'Người thuê A', avatarUrl: null },
    attachments: [],
    ...overrides,
  };
}

describe('RepairTicketService Static Architecture Guard (AGENTS.md §2.2)', () => {
  test('repair-ticket.repository.ts không import ApiError, notification.util, audit-log.util và không gọi $transaction', () => {
    const repoPath = path.resolve(
      __dirname,
      '../../src/modules/repair-tickets/repair-ticket.repository.ts',
    );
    const source = fs.readFileSync(repoPath, 'utf8');

    assert.ok(!source.includes('ApiError'), 'Repository không được dùng ApiError');
    assert.ok(!source.includes('notification.util'), 'Repository không được import notification.util');
    assert.ok(!source.includes('audit-log.util'), 'Repository không được import audit-log.util');
    assert.ok(!source.includes('$transaction'), 'Repository không được mở $transaction');
  });
});

describe('RepairTicketService Unit Tests (Q1–Q9 & Cloudinary Rollback)', () => {
  test('createRepairTicket: pre-check không có HĐ ACTIVE -> 404 và 0 ảnh upload Cloudinary', async () => {
    const media = stubMedia();
    stubRepo('findActiveResidencyForRoom', async () => null);

    await assert.rejects(
      () =>
        RepairTicketService.createRepairTicket(
          {
            roomId: ROOM_ID,
            title: 'Máy lạnh hư',
            description: 'Máy lạnh không làm mát nữa',
            priority: REPAIR_TICKET_PRIORITY.MEDIUM,
          },
          [fakeFile()],
          primaryUser,
        ),
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.statusCode, 404);
        assert.equal(err.code, 'ROOM_NOT_FOUND');
        return true;
      },
    );
    assert.equal(media.uploaded.length, 0);
  });

  test('createRepairTicket: roomId kèm propertyId lệch -> 404 ROOM_NOT_FOUND', async () => {
    const media = stubMedia();
    stubRepo('findActiveResidencyForRoom', async () => ({
      contractId: CONTRACT_ID,
      roomId: ROOM_ID,
      propertyId: PROP_ID,
      landlordId: LANDLORD_ID,
    }));

    await assert.rejects(
      () =>
        RepairTicketService.createRepairTicket(
          {
            roomId: ROOM_ID,
            propertyId: OTHER_PROP_ID,
            title: 'Máy lạnh hư',
            description: 'Máy lạnh không làm mát nữa',
            priority: REPAIR_TICKET_PRIORITY.MEDIUM,
          },
          [fakeFile()],
          primaryUser,
        ),
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.statusCode, 404);
        assert.equal(err.code, 'ROOM_NOT_FOUND');
        return true;
      },
    );
    assert.equal(media.uploaded.length, 0);
  });

  test('createRepairTicket: mất tư cách cư trú sau lock Contract FOR UPDATE -> rollback xóa toàn bộ ảnh Cloudinary', async () => {
    const media = stubMedia();
    stubTransaction();
    let calls = 0;
    stubRepo('findActiveResidencyForRoom', async () => {
      calls += 1;
      if (calls === 1) {
        return {
          contractId: CONTRACT_ID,
          roomId: ROOM_ID,
          propertyId: PROP_ID,
          landlordId: LANDLORD_ID,
        };
      }
      return null;
    });
    stubRepo('lockContractRow', async () => true);

    await assert.rejects(
      () =>
        RepairTicketService.createRepairTicket(
          {
            roomId: ROOM_ID,
            title: 'Máy lạnh hư',
            description: 'Máy lạnh không làm mát nữa',
            priority: REPAIR_TICKET_PRIORITY.MEDIUM,
          },
          [fakeFile('1.png'), fakeFile('2.png')],
          primaryUser,
        ),
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.statusCode, 404);
        assert.equal(err.code, 'ROOM_NOT_FOUND');
        return true;
      },
    );

    assert.equal(media.uploaded.length, 2);
    assert.deepEqual(media.deleted, media.uploaded);
  });

  test('listRepairTickets & getRepairTicketDetail (Q1, Q9): cựu cư dân bị cắt quyền xem, list chạy lazy auto-close batchSize 50', async () => {
    stubRepo('findTenantActiveScope', async () => ({
      activeRoomIds: [],
      activePropertyIds: [],
    }));
    const emptyList = await RepairTicketService.listRepairTickets({ page: 1, limit: 20 }, primaryUser);
    assert.deepEqual(emptyList, { items: [], total: 0, page: 1, limit: 20, totalPages: 0 });

    let lazyBatchSize = 0;
    stubRepo('findTenantActiveScope', async () => ({
      activeRoomIds: [ROOM_ID],
      activePropertyIds: [PROP_ID],
    }));
    stubRepo('findStaleAwaitingConfirmationTicketIds', async (_cutoff, limit) => {
      lazyBatchSize = limit;
      return [];
    });
    stubRepo('findTicketsPaginated', async () => ({ items: [], total: 0 }));

    await RepairTicketService.listRepairTickets({ page: 1, limit: 20 }, primaryUser);
    assert.equal(lazyBatchSize, 50);

    stubRepo('findTicketForMutation', async () => makeMutationRow({ roomId: ROOM_ID }));
    stubRepo('findActiveResidencyForRoom', async () => null);
    await assert.rejects(
      () => RepairTicketService.getRepairTicketDetail(TICKET_ID, primaryUser),
      (err: unknown) => err instanceof ApiError && err.statusCode === 404 && err.code === 'REPAIR_TICKET_NOT_FOUND',
    );

    stubRepo('findTicketForMutation', async () => makeMutationRow({ roomId: null }));
    stubRepo('findActiveResidencyForProperty', async () => null);
    await assert.rejects(
      () => RepairTicketService.getRepairTicketDetail(TICKET_ID, primaryUser),
      (err: unknown) => err instanceof ApiError && err.statusCode === 404 && err.code === 'REPAIR_TICKET_NOT_FOUND',
    );
  });

  test('listRepairTickets: thu hẹp extraWhere truyền vào autoCloseStaleRepairTickets theo propertyId và roomId (không gộp status)', async () => {
    let capturedExtraWhere: unknown;
    stubRepo('findStaleAwaitingConfirmationTicketIds', async (_cutoff, _limit, extraWhere) => {
      capturedExtraWhere = extraWhere;
      return [];
    });
    stubRepo('findTicketsPaginated', async () => ({ items: [], total: 0 }));

    await RepairTicketService.listRepairTickets(
      {
        status: REPAIR_TICKET_STATUS.CLOSED,
        priority: REPAIR_TICKET_PRIORITY.HIGH,
        propertyId: PROP_ID,
        roomId: ROOM_ID,
        page: 1,
        limit: 20,
      },
      landlordUser,
    );

    assert.deepEqual(capturedExtraWhere, {
      AND: [
        { property: { landlordId: LANDLORD_ID } },
        { propertyId: PROP_ID },
        { roomId: ROOM_ID },
      ],
    });

    await RepairTicketService.listRepairTickets(
      {
        status: REPAIR_TICKET_STATUS.OPEN,
        priority: REPAIR_TICKET_PRIORITY.LOW,
        page: 1,
        limit: 20,
      },
      landlordUser,
    );
    assert.deepEqual(capturedExtraWhere, { property: { landlordId: LANDLORD_ID } });
  });

  test('acceptRepairTicket & completeRepairTicket (Q7): chủ trọ khác -> 404, thông báo đủ cư dân ACTIVE, rollback Cloudinary khi DB lỗi', async () => {
    const media = stubMedia();
    stubRepo('findTicketForMutation', async () =>
      makeMutationRow({
        status: REPAIR_TICKET_STATUS.IN_PROGRESS,
        property: { id: PROP_ID, landlordId: 'other-landlord' },
      }),
    );

    await assert.rejects(
      () => RepairTicketService.completeRepairTicket(TICKET_ID, {}, [fakeFile()], landlordUser),
      (err: unknown) => err instanceof ApiError && err.statusCode === 404,
    );
    assert.equal(media.uploaded.length, 0);

    const txCap = stubTransaction();
    stubRepo('lockTicketRow', async () => true);
    stubRepo('findTicketForMutation', async () => makeMutationRow({ status: REPAIR_TICKET_STATUS.OPEN }));
    stubRepo('updateTicket', async () => {});
    stubRepo('findActiveResidentUserIdsForRoom', async () => [PRIMARY_ID, CO_RESIDENT_B_ID]);
    stubRepo('findTicketDetailById', async () => makeDetailRow({ status: REPAIR_TICKET_STATUS.IN_PROGRESS }));
    stubRepo('findReopenAuditLogs', async () => []);

    await RepairTicketService.acceptRepairTicket(
      TICKET_ID,
      { resolutionPlan: 'Gọi thợ kiểm tra', scheduledAt: new Date('2026-11-25T09:00:00.000Z') },
      landlordUser,
    );
    assert.deepEqual(
      txCap.notifications.map((n) => n.recipientId),
      [PRIMARY_ID, CO_RESIDENT_B_ID],
    );
    assert.equal(txCap.notifications[0].eventType, NOTIFICATION_EVENT_TYPE.REPAIR_TICKET_ACCEPTED);

    // complete DB error -> rollback Cloudinary
    let mutCall = 0;
    stubRepo('findTicketForMutation', async () => {
      mutCall += 1;
      if (mutCall === 1) return makeMutationRow({ status: REPAIR_TICKET_STATUS.IN_PROGRESS });
      return makeMutationRow({ status: REPAIR_TICKET_STATUS.CLOSED });
    });
    await assert.rejects(
      () => RepairTicketService.completeRepairTicket(TICKET_ID, {}, [fakeFile(), fakeFile()], landlordUser),
      (err: unknown) => err instanceof ApiError && err.statusCode === 409 && err.code === 'REPAIR_TICKET_ALREADY_CLOSED',
    );
    assert.deepEqual(media.deleted, media.uploaded);
  });

  test('confirmCompletion (Q1, Q7): CO_RESIDENT nghiệm thu thành công, gửi Landlord + thành viên khác (loại caller); khu vực chung chặn tenant khác', async () => {
    const txCap = stubTransaction();
    stubRepo('lockTicketRow', async () => true);
    stubRepo('findTicketForMutation', async () => makeMutationRow({ roomId: ROOM_ID }));
    stubRepo('findActiveResidencyForRoom', async () => ({
      contractId: CONTRACT_ID,
      roomId: ROOM_ID,
      propertyId: PROP_ID,
      landlordId: LANDLORD_ID,
    }));
    stubRepo('updateTicket', async () => {});
    stubRepo('findActiveResidentUserIdsForRoom', async () => [
      PRIMARY_ID,
      CO_RESIDENT_B_ID,
      CO_RESIDENT_C_ID,
    ]);
    stubRepo('findTicketDetailById', async () =>
      makeDetailRow({ status: REPAIR_TICKET_STATUS.CLOSED }),
    );
    stubRepo('findReopenAuditLogs', async () => []);

    const dto = await RepairTicketService.confirmCompletion(TICKET_ID, coResidentBUser);
    assert.equal(dto.status, REPAIR_TICKET_STATUS.CLOSED);
    assert.equal(txCap.notifications.length, 3);
    const recipients = txCap.notifications.map((n) => ({
      recipientId: n.recipientId,
      actionUrl: n.payload?.actionUrl,
    }));
    assert.deepEqual(recipients, [
      { recipientId: LANDLORD_ID, actionUrl: `/landlord/repair-tickets/${TICKET_ID}` },
      { recipientId: PRIMARY_ID, actionUrl: `/repair-tickets/${TICKET_ID}` },
      { recipientId: CO_RESIDENT_C_ID, actionUrl: `/repair-tickets/${TICKET_ID}` },
    ]);

    // Khu vực chung: tenant khác cùng khu trọ -> 404 sau lock
    stubRepo('findTicketForMutation', async () =>
      makeMutationRow({ roomId: null, createdById: PRIMARY_ID }),
    );
    await assert.rejects(
      () => RepairTicketService.confirmCompletion(TICKET_ID, otherTenantUser),
      (err: unknown) => err instanceof ApiError && err.statusCode === 404 && err.code === 'REPAIR_TICKET_NOT_FOUND',
    );
  });

  test('rejectCompletion (Q2, Q3, Q6): 0 ảnh reset chi phí, lưu AuditLog; quá 5 ngày commit CLOSED, dọn ảnh và ném 409 REPAIR_TICKET_AUTO_CLOSED', async () => {
    const txCap = stubTransaction();
    let updatedPayload: Record<string, any> | null = null;
    let attachmentsCreated = false;

    stubRepo('lockTicketRow', async () => true);
    stubRepo('findTicketForMutation', async () =>
      makeMutationRow({
        completedAt: new Date(Date.now() - 60 * 60 * 1000),
        repairCost: 500000,
        costBearer: REPAIR_COST_BEARER.LANDLORD,
      }),
    );
    stubRepo('findActiveResidencyForRoom', async () => ({
      contractId: CONTRACT_ID,
      roomId: ROOM_ID,
      propertyId: PROP_ID,
      landlordId: LANDLORD_ID,
    }));
    stubRepo('updateTicket', async (_tx, _id, data) => {
      updatedPayload = data as Record<string, any>;
    });
    stubRepo('createAttachments', async () => {
      attachmentsCreated = true;
    });
    stubRepo('findTicketDetailById', async () =>
      makeDetailRow({
        status: REPAIR_TICKET_STATUS.IN_PROGRESS,
        completedAt: null,
        repairCost: null,
        costBearer: null,
      }),
    );
    stubRepo('findReopenAuditLogs', async () => [
      {
        actorId: PRIMARY_ID,
        newData: { reason: 'Vẫn còn rò rỉ nước sau khi thợ về', attachmentCount: 0 },
        createdAt: new Date(),
      },
    ]);

    const reopened = await RepairTicketService.rejectCompletion(
      TICKET_ID,
      { reason: 'Vẫn còn rò rỉ nước sau khi thợ về' },
      [],
      primaryUser,
    );
    assert.equal(reopened.status, REPAIR_TICKET_STATUS.IN_PROGRESS);
    assert.equal(attachmentsCreated, false);
    assert.equal(updatedPayload?.completedAt, null);
    assert.equal(updatedPayload?.repairCost, null);
    assert.equal(updatedPayload?.costBearer, null);
    assert.equal(txCap.auditLogs[0].action, 'REPAIR_TICKET_REOPENED');
    assert.equal(txCap.auditLogs[0].oldData.repairCost, 500000);
    assert.equal(txCap.notifications[0].eventType, NOTIFICATION_EVENT_TYPE.REPAIR_TICKET_REOPENED);

    // Quá 5 ngày ngay ở preCheck -> autoCloseSingleTicketIfStale + 0 lần upload Cloudinary + 409 REPAIR_TICKET_AUTO_CLOSED
    const media = stubMedia();
    const expiredTx = stubTransaction();
    const expiredAt = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    stubRepo('findTicketForMutation', async () => makeMutationRow({ completedAt: expiredAt }));
    stubRepo('findActiveResidentUserIdsForRoom', async () => [PRIMARY_ID]);

    await assert.rejects(
      () =>
        RepairTicketService.rejectCompletion(
          TICKET_ID,
          { reason: 'Quá hạn 5 ngày vẫn gửi phản hồi' },
          [fakeFile()],
          primaryUser,
        ),
      (err: unknown) =>
        err instanceof ApiError &&
        err.statusCode === 409 &&
        err.code === 'REPAIR_TICKET_AUTO_CLOSED',
    );
    assert.equal(media.uploaded.length, 0);
    assert.equal(media.deleted.length, 0);
    assert.equal(expiredTx.committedCount(), 1);
    assert.equal(expiredTx.auditLogs[0].action, 'REPAIR_TICKET_AUTO_CLOSED');

    // Quá 5 ngày xảy ra sau preCheck (trong lúc upload ảnh) -> vẫn rollback ảnh Cloudinary + commit CLOSED + 409
    const raceMedia = stubMedia();
    const raceTx = stubTransaction();
    let rejectFindCalls = 0;
    stubRepo('findTicketForMutation', async () => {
      rejectFindCalls += 1;
      if (rejectFindCalls === 1) {
        return makeMutationRow({ completedAt: new Date(Date.now() - 60 * 60 * 1000) });
      }
      return makeMutationRow({ completedAt: expiredAt });
    });

    await assert.rejects(
      () =>
        RepairTicketService.rejectCompletion(
          TICKET_ID,
          { reason: 'Vừa quá hạn 5 ngày trong lúc đang upload ảnh' },
          [fakeFile()],
          primaryUser,
        ),
      (err: unknown) =>
        err instanceof ApiError &&
        err.statusCode === 409 &&
        err.code === 'REPAIR_TICKET_AUTO_CLOSED',
    );
    assert.equal(raceTx.committedCount(), 1);
    assert.equal(raceTx.auditLogs[0].action, 'REPAIR_TICKET_AUTO_CLOSED');
    assert.equal(raceMedia.uploaded.length, 1);
    assert.deepEqual(raceMedia.deleted, raceMedia.uploaded);
  });

  test('autoCloseStaleRepairTickets (Q8): cô lập lỗi từng bản ghi và SKIP LOCKED', async () => {
    const txCap = stubTransaction();
    const originalConsoleError = console.error;
    console.error = () => {};
    restorers.push(() => {
      console.error = originalConsoleError;
    });

    stubRepo('findStaleAwaitingConfirmationTicketIds', async () => ['t-1', 't-2', 't-3']);
    stubRepo('lockTicketRowSkipLocked', async (_tx, ticketId) => ticketId !== 't-2');
    stubRepo('findTicketForMutation', async (_tx, ticketId) => {
      if (ticketId === 't-3') {
        throw new Error('Simulated DB error for t-3');
      }
      return makeMutationRow({
        id: ticketId,
        completedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      });
    });
    stubRepo('updateTicket', async () => {});
    stubRepo('findActiveResidentUserIdsForRoom', async () => [PRIMARY_ID]);

    const result = await autoCloseStaleRepairTickets({ batchSize: 100 });
    assert.deepEqual(result, {
      scanned: 3,
      closedCount: 1,
      skippedCount: 1,
      failedCount: 1,
    });
    assert.equal(txCap.committedCount(), 2); // t-1 closed, t-2 skipped cleanly; t-3 failed
  });
});
