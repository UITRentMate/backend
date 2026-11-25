import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { app } from '../../src/app';
import {
  REPAIR_COST_BEARER,
  REPAIR_TICKET_PRIORITY,
  REPAIR_TICKET_STATUS,
} from '../../src/common/constants/phase3-status';
import { prisma } from '../../src/infrastructure/database/prisma';
import {
  clearRegisteredPhase3Jobs,
  listRegisteredPhase3Jobs,
  registerRepairTicketAutoCloseJob,
} from '../../src/infrastructure/scheduler/phase3-timers';
import { signAccessToken } from '../../src/modules/auth/auth.security';
import { RepairTicketService } from '../../src/modules/repair-tickets/repair-ticket.service';
import type { RepairTicketDetailDTO } from '../../src/modules/repair-tickets/repair-ticket.types';

process.env.JWT_SECRET = 'test-secret-must-have-at-least-thirty-two-bytes';

const TICKET_ID = '11111111-2222-4333-8444-555555555555';
const PROP_ID = '22222222-3333-4444-8555-666666666666';
const ROOM_ID = '33333333-4444-4555-8666-777777777777';

const tenantUser = {
  id: '44444444-5555-4666-8777-888888888888',
  fullName: 'Tenant Active',
  role: 'TENANT',
  accountStatus: 'ACTIVE',
};
const landlordUser = {
  id: '55555555-6666-4777-8888-999999999999',
  fullName: 'Landlord Active',
  role: 'LANDLORD',
  accountStatus: 'ACTIVE',
};
const adminUser = {
  id: '66666666-7777-4888-8999-aaaaaaaaaaaa',
  fullName: 'Admin Active',
  role: 'ADMIN',
  accountStatus: 'ACTIVE',
};
const lockedUser = {
  id: '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
  fullName: 'Tenant Locked',
  role: 'TENANT',
  accountStatus: 'LOCKED',
};

const VALID_PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

const SAMPLE_DETAIL_DTO: RepairTicketDetailDTO = {
  id: TICKET_ID,
  property: { id: PROP_ID, name: 'Nhà trọ Hoa Mai', address: '123 Đường D1' },
  room: { id: ROOM_ID, roomCode: 'P.201' },
  createdBy: { id: tenantUser.id, fullName: tenantUser.fullName, avatarUrl: null },
  title: 'Máy lạnh chảy nước',
  description: 'Máy lạnh chảy nước xuống sàn từ tối hôm qua',
  priority: REPAIR_TICKET_PRIORITY.HIGH,
  status: REPAIR_TICKET_STATUS.OPEN,
  resolutionPlan: null,
  repairCost: null,
  costBearer: null,
  scheduledAt: null,
  completedAt: null,
  closedAt: null,
  createdAt: '2026-11-24T05:00:00.000Z',
  canEscalateToComplaint: false,
  autoCloseAt: null,
  latestRejectionReason: null,
  reopenHistory: [],
  attachments: [],
  attachmentsByStage: { INITIAL: [], COMPLETION: [], REOPEN_EVIDENCE: [] },
};

const undo: Array<() => void> = [];
afterEach(() => {
  while (undo.length > 0) {
    undo.pop()!();
  }
});

function stub(target: Record<string, any>, key: string, impl: (...args: any[]) => any) {
  const original = target[key];
  target[key] = impl;
  undo.push(() => {
    target[key] = original;
  });
}

async function withServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function authHeader(userId: string): Record<string, string> {
  return { Authorization: `Bearer ${signAccessToken(userId)}` };
}

describe('Repair Ticket HTTP API & Scheduler Tests', () => {
  test('repair-ticket.controller.ts không import prisma trực tiếp', () => {
    const controllerPath = path.resolve(
      __dirname,
      '../../src/modules/repair-tickets/repair-ticket.controller.ts',
    );
    const source = fs.readFileSync(controllerPath, 'utf8');
    assert.ok(!source.includes('infrastructure/database/prisma'));
    assert.ok(!source.includes('prisma.'));
  });

  test('registerRepairTicketAutoCloseJob đăng ký job repair-ticket-auto-close chu kỳ 15 phút', () => {
    clearRegisteredPhase3Jobs();
    try {
      registerRepairTicketAutoCloseJob();
      const jobs = listRegisteredPhase3Jobs();
      const job = jobs.find((item) => item.name === 'repair-ticket-auto-close');
      assert.ok(job, 'Job repair-ticket-auto-close phải được đăng ký');
      assert.equal(job.intervalMs, 15 * 60 * 1000);
    } finally {
      clearRegisteredPhase3Jobs();
    }
  });

  test('Thiếu access token trả 401 UNAUTHORIZED trên cả 7 endpoints', async () => {
    await withServer(async (baseUrl) => {
      const endpoints: Array<[string, string]> = [
        ['POST', '/api/v1/repair-tickets'],
        ['GET', '/api/v1/repair-tickets'],
        ['GET', `/api/v1/repair-tickets/${TICKET_ID}`],
        ['PATCH', `/api/v1/repair-tickets/${TICKET_ID}/accept`],
        ['PATCH', `/api/v1/repair-tickets/${TICKET_ID}/complete`],
        ['PATCH', `/api/v1/repair-tickets/${TICKET_ID}/confirm-completion`],
        ['PATCH', `/api/v1/repair-tickets/${TICKET_ID}/reject-completion`],
      ];

      for (const [method, url] of endpoints) {
        const res = await fetch(`${baseUrl}${url}`, { method });
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(res.status, 401, `${method} ${url} expected 401, got ${res.status}`);
        assert.equal(body.code, 'UNAUTHORIZED');
      }
    });
  });

  test('Tài khoản LOCKED trả 403 ACCOUNT_LOCKED', async () => {
    stub(prisma.user, 'findUnique', async () => lockedUser);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/repair-tickets`, {
        headers: authHeader(lockedUser.id),
      });
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 403);
      assert.equal(body.code, 'ACCOUNT_LOCKED');
    });
  });

  test('RBAC: ADMIN chặn 403 cả 7 endpoints; LANDLORD chặn 403 POST/confirm/reject; TENANT chặn 403 accept/complete', async () => {
    stub(prisma.user, 'findUnique', async ({ where }: any) => {
      if (where.id === adminUser.id) return adminUser;
      if (where.id === landlordUser.id) return landlordUser;
      if (where.id === tenantUser.id) return tenantUser;
      return null;
    });

    await withServer(async (baseUrl) => {
      const allEndpoints: Array<[string, string]> = [
        ['POST', '/api/v1/repair-tickets'],
        ['GET', '/api/v1/repair-tickets'],
        ['GET', `/api/v1/repair-tickets/${TICKET_ID}`],
        ['PATCH', `/api/v1/repair-tickets/${TICKET_ID}/accept`],
        ['PATCH', `/api/v1/repair-tickets/${TICKET_ID}/complete`],
        ['PATCH', `/api/v1/repair-tickets/${TICKET_ID}/confirm-completion`],
        ['PATCH', `/api/v1/repair-tickets/${TICKET_ID}/reject-completion`],
      ];
      for (const [method, url] of allEndpoints) {
        const res = await fetch(`${baseUrl}${url}`, {
          method,
          headers: authHeader(adminUser.id),
        });
        assert.equal(res.status, 403);
        assert.equal(((await res.json()) as any).code, 'FORBIDDEN');
      }

      for (const [method, url] of [
        ['POST', '/api/v1/repair-tickets'],
        ['PATCH', `/api/v1/repair-tickets/${TICKET_ID}/confirm-completion`],
        ['PATCH', `/api/v1/repair-tickets/${TICKET_ID}/reject-completion`],
      ]) {
        const res = await fetch(`${baseUrl}${url}`, {
          method,
          headers: authHeader(landlordUser.id),
        });
        assert.equal(res.status, 403);
        assert.equal(((await res.json()) as any).code, 'FORBIDDEN');
      }

      for (const [method, url] of [
        ['PATCH', `/api/v1/repair-tickets/${TICKET_ID}/accept`],
        ['PATCH', `/api/v1/repair-tickets/${TICKET_ID}/complete`],
      ]) {
        const res = await fetch(`${baseUrl}${url}`, {
          method,
          headers: authHeader(tenantUser.id),
        });
        assert.equal(res.status, 403);
        assert.equal(((await res.json()) as any).code, 'FORBIDDEN');
      }
    });
  });

  test('Multipart upload validation: thiếu ảnh, vượt maxCount, sai field, giả MIME, > 5MB', async () => {
    stub(prisma.user, 'findUnique', async ({ where }: any) => {
      if (where.id === landlordUser.id) return landlordUser;
      return tenantUser;
    });

    await withServer(async (baseUrl) => {
      // POST thiếu ảnh -> 400 ATTACHMENTS_REQUIRED
      const missingForm = new FormData();
      missingForm.append('roomId', ROOM_ID);
      missingForm.append('title', 'Máy lạnh hỏng');
      missingForm.append('description', 'Không làm mát từ tối qua');
      const rMissingPost = await fetch(`${baseUrl}/api/v1/repair-tickets`, {
        method: 'POST',
        headers: authHeader(tenantUser.id),
        body: missingForm,
      });
      assert.equal(rMissingPost.status, 400);
      assert.equal(((await rMissingPost.json()) as any).code, 'ATTACHMENTS_REQUIRED');

      // PATCH /complete thiếu ảnh -> 400 ATTACHMENTS_REQUIRED
      const rMissingComplete = await fetch(`${baseUrl}/api/v1/repair-tickets/${TICKET_ID}/complete`, {
        method: 'PATCH',
        headers: authHeader(landlordUser.id),
        body: new FormData(),
      });
      assert.equal(rMissingComplete.status, 400);
      assert.equal(((await rMissingComplete.json()) as any).code, 'ATTACHMENTS_REQUIRED');

      // POST gửi 6 ảnh -> 400 ATTACHMENT_LIMIT_EXCEEDED
      const sixFilesForm = new FormData();
      sixFilesForm.append('roomId', ROOM_ID);
      sixFilesForm.append('title', 'Máy lạnh hỏng');
      sixFilesForm.append('description', 'Không làm mát từ tối qua');
      for (let i = 0; i < 6; i += 1) {
        sixFilesForm.append('attachments', new Blob([VALID_PNG_BYTES], { type: 'image/png' }), `${i}.png`);
      }
      const rSix = await fetch(`${baseUrl}/api/v1/repair-tickets`, {
        method: 'POST',
        headers: authHeader(tenantUser.id),
        body: sixFilesForm,
      });
      assert.equal(rSix.status, 400);
      assert.equal(((await rSix.json()) as any).code, 'ATTACHMENT_LIMIT_EXCEEDED');

      // PATCH /reject-completion gửi 4 ảnh -> 400 ATTACHMENT_LIMIT_EXCEEDED
      const fourRejectForm = new FormData();
      fourRejectForm.append('reason', 'Lý do từ chối nghiệm thu đủ mười ký tự');
      for (let i = 0; i < 4; i += 1) {
        fourRejectForm.append('attachments', new Blob([VALID_PNG_BYTES], { type: 'image/png' }), `${i}.png`);
      }
      const rFourReject = await fetch(`${baseUrl}/api/v1/repair-tickets/${TICKET_ID}/reject-completion`, {
        method: 'PATCH',
        headers: authHeader(tenantUser.id),
        body: fourRejectForm,
      });
      assert.equal(rFourReject.status, 400);
      assert.equal(((await rFourReject.json()) as any).code, 'ATTACHMENT_LIMIT_EXCEEDED');

      // Sai tên field -> 400 INVALID_FILE_UPLOAD
      const wrongFieldForm = new FormData();
      wrongFieldForm.append('images', new Blob([VALID_PNG_BYTES], { type: 'image/png' }), 'a.png');
      const rWrongField = await fetch(`${baseUrl}/api/v1/repair-tickets`, {
        method: 'POST',
        headers: authHeader(tenantUser.id),
        body: wrongFieldForm,
      });
      assert.equal(rWrongField.status, 400);
      assert.equal(((await rWrongField.json()) as any).code, 'INVALID_FILE_UPLOAD');

      // Giả mạo MIME image/jpeg với text -> 415 UNSUPPORTED_MEDIA_TYPE
      const spoofedForm = new FormData();
      spoofedForm.append('roomId', ROOM_ID);
      spoofedForm.append('title', 'Máy lạnh hỏng');
      spoofedForm.append('description', 'Không làm mát từ tối qua');
      spoofedForm.append('attachments', new Blob(['not-an-image'], { type: 'image/jpeg' }), 'fake.jpg');
      const rSpoofed = await fetch(`${baseUrl}/api/v1/repair-tickets`, {
        method: 'POST',
        headers: authHeader(tenantUser.id),
        body: spoofedForm,
      });
      assert.equal(rSpoofed.status, 415);
      assert.equal(((await rSpoofed.json()) as any).code, 'UNSUPPORTED_MEDIA_TYPE');

      // File > 5MB -> 413 FILE_TOO_LARGE
      const bigBytes = new Uint8Array(5 * 1024 * 1024 + 10);
      bigBytes.set(VALID_PNG_BYTES, 0);
      const bigForm = new FormData();
      bigForm.append('attachments', new Blob([bigBytes], { type: 'image/png' }), 'big.png');
      const rBig = await fetch(`${baseUrl}/api/v1/repair-tickets`, {
        method: 'POST',
        headers: authHeader(tenantUser.id),
        body: bigForm,
      });
      assert.equal(rBig.status, 413);
      assert.equal(((await rBig.json()) as any).code, 'FILE_TOO_LARGE');
    });
  });

  test('Validation path/query và happy path 7 endpoints (bao gồm reject-completion JSON & multipart 0/2 ảnh)', async () => {
    stub(prisma.user, 'findUnique', async ({ where }: any) => {
      if (where.id === landlordUser.id) return landlordUser;
      return tenantUser;
    });

    stub(RepairTicketService, 'createRepairTicket', async () => SAMPLE_DETAIL_DTO);
    stub(RepairTicketService, 'listRepairTickets', async () => ({
      items: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    }));
    stub(RepairTicketService, 'getRepairTicketDetail', async () => SAMPLE_DETAIL_DTO);
    stub(RepairTicketService, 'acceptRepairTicket', async () => ({
      ...SAMPLE_DETAIL_DTO,
      status: REPAIR_TICKET_STATUS.IN_PROGRESS,
    }));
    stub(RepairTicketService, 'completeRepairTicket', async () => ({
      ...SAMPLE_DETAIL_DTO,
      status: REPAIR_TICKET_STATUS.AWAITING_CONFIRMATION,
      repairCost: 350000,
      costBearer: REPAIR_COST_BEARER.LANDLORD,
    }));
    stub(RepairTicketService, 'confirmCompletion', async () => ({
      ...SAMPLE_DETAIL_DTO,
      status: REPAIR_TICKET_STATUS.CLOSED,
    }));
    let lastRejectFilesCount = -1;
    stub(RepairTicketService, 'rejectCompletion', async (_id, _input, files) => {
      lastRejectFilesCount = files.length;
      return {
        ...SAMPLE_DETAIL_DTO,
        status: REPAIR_TICKET_STATUS.IN_PROGRESS,
      };
    });

    await withServer(async (baseUrl) => {
      // Bad UUID & pagination bounds
      const rBadUuid = await fetch(`${baseUrl}/api/v1/repair-tickets/not-uuid`, {
        headers: authHeader(tenantUser.id),
      });
      assert.equal(rBadUuid.status, 400);
      assert.equal(((await rBadUuid.json()) as any).code, 'VALIDATION_ERROR');

      const rBadPage = await fetch(`${baseUrl}/api/v1/repair-tickets?page=10001`, {
        headers: authHeader(tenantUser.id),
      });
      assert.equal(rBadPage.status, 400);
      assert.equal(((await rBadPage.json()) as any).code, 'VALIDATION_ERROR');

      const rBadLimit = await fetch(`${baseUrl}/api/v1/repair-tickets?limit=51`, {
        headers: authHeader(tenantUser.id),
      });
      assert.equal(rBadLimit.status, 400);
      assert.equal(((await rBadLimit.json()) as any).code, 'VALIDATION_ERROR');

      // 1. POST /repair-tickets -> 201
      const createForm = new FormData();
      createForm.append('roomId', ROOM_ID);
      createForm.append('title', 'Máy lạnh chảy nước');
      createForm.append('description', 'Chảy nước liên tục xuống sàn phòng ngủ');
      createForm.append('attachments', new Blob([VALID_PNG_BYTES], { type: 'image/png' }), 'a.png');
      const rCreate = await fetch(`${baseUrl}/api/v1/repair-tickets`, {
        method: 'POST',
        headers: authHeader(tenantUser.id),
        body: createForm,
      });
      assert.equal(rCreate.status, 201);

      // 2. GET /repair-tickets -> 200
      const rList = await fetch(`${baseUrl}/api/v1/repair-tickets?page=1&limit=20`, {
        headers: authHeader(tenantUser.id),
      });
      assert.equal(rList.status, 200);

      // 3. GET /repair-tickets/:ticketId -> 200
      const rDetail = await fetch(`${baseUrl}/api/v1/repair-tickets/${TICKET_ID}`, {
        headers: authHeader(tenantUser.id),
      });
      assert.equal(rDetail.status, 200);

      // 4. PATCH /accept -> 200
      const futureIso = new Date(Date.now() + 3600_000).toISOString();
      const rAccept = await fetch(`${baseUrl}/api/v1/repair-tickets/${TICKET_ID}/accept`, {
        method: 'PATCH',
        headers: { ...authHeader(landlordUser.id), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resolutionPlan: 'Gọi thợ đến kiểm tra máy lạnh',
          scheduledAt: futureIso,
        }),
      });
      assert.equal(rAccept.status, 200);

      // 5. PATCH /complete -> 200
      const completeForm = new FormData();
      completeForm.append('repairCost', '350000');
      completeForm.append('costBearer', 'LANDLORD');
      completeForm.append('attachments', new Blob([VALID_PNG_BYTES], { type: 'image/png' }), 'done.png');
      const rComplete = await fetch(`${baseUrl}/api/v1/repair-tickets/${TICKET_ID}/complete`, {
        method: 'PATCH',
        headers: authHeader(landlordUser.id),
        body: completeForm,
      });
      assert.equal(rComplete.status, 200);

      // 6. PATCH /confirm-completion -> 200
      const rConfirm = await fetch(`${baseUrl}/api/v1/repair-tickets/${TICKET_ID}/confirm-completion`, {
        method: 'PATCH',
        headers: authHeader(tenantUser.id),
      });
      assert.equal(rConfirm.status, 200);

      // 7a. PATCH /reject-completion (application/json) -> 200
      const rRejectJson = await fetch(`${baseUrl}/api/v1/repair-tickets/${TICKET_ID}/reject-completion`, {
        method: 'PATCH',
        headers: { ...authHeader(tenantUser.id), 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Máy lạnh vẫn còn chảy nước sau sửa' }),
      });
      assert.equal(rRejectJson.status, 200);
      assert.equal(lastRejectFilesCount, 0);

      // 7b. PATCH /reject-completion (multipart 0 ảnh) -> 200
      const rejectZeroForm = new FormData();
      rejectZeroForm.append('reason', 'Máy lạnh vẫn còn chảy nước sau sửa');
      const rRejectZero = await fetch(`${baseUrl}/api/v1/repair-tickets/${TICKET_ID}/reject-completion`, {
        method: 'PATCH',
        headers: authHeader(tenantUser.id),
        body: rejectZeroForm,
      });
      assert.equal(rRejectZero.status, 200);
      assert.equal(lastRejectFilesCount, 0);

      // 7c. PATCH /reject-completion (multipart 2 ảnh) -> 200
      const rejectTwoForm = new FormData();
      rejectTwoForm.append('reason', 'Máy lạnh vẫn còn chảy nước sau sửa');
      rejectTwoForm.append('attachments', new Blob([VALID_PNG_BYTES], { type: 'image/png' }), '1.png');
      rejectTwoForm.append('attachments', new Blob([VALID_PNG_BYTES], { type: 'image/png' }), '2.png');
      const rRejectTwo = await fetch(`${baseUrl}/api/v1/repair-tickets/${TICKET_ID}/reject-completion`, {
        method: 'PATCH',
        headers: authHeader(tenantUser.id),
        body: rejectTwoForm,
      });
      assert.equal(rRejectTwo.status, 200);
      assert.equal(lastRejectFilesCount, 2);

      // 7d. PATCH /reject-completion với field thừa -> 400 VALIDATION_ERROR
      const rRejectExtra = await fetch(`${baseUrl}/api/v1/repair-tickets/${TICKET_ID}/reject-completion`, {
        method: 'PATCH',
        headers: { ...authHeader(tenantUser.id), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: 'Máy lạnh vẫn còn chảy nước sau sửa',
          extraField: 'unexpected',
        }),
      });
      assert.equal(rRejectExtra.status, 400);
      assert.equal(((await rRejectExtra.json()) as any).code, 'VALIDATION_ERROR');
    });
  });
});
