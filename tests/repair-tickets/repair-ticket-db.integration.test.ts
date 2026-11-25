import '../../src/config/env';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, describe, test } from 'node:test';
import { app } from '../../src/app';
import {
  CONTRACT_STATUS,
  NOTIFICATION_EVENT_TYPE,
  REPAIR_ATTACHMENT_STAGE,
  REPAIR_COST_BEARER,
  REPAIR_TICKET_PRIORITY,
  REPAIR_TICKET_STATUS,
} from '../../src/common/constants/phase3-status';
import { prisma } from '../../src/infrastructure/database/prisma';
import { signAccessToken } from '../../src/modules/auth/auth.security';
import { mediaService } from '../../src/modules/media/media.service';
import { autoCloseStaleRepairTickets } from '../../src/modules/repair-tickets/repair-ticket.service';

process.env.JWT_SECRET = 'test-secret-must-have-at-least-thirty-two-bytes';

const VALID_PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

describe('Repair Tickets PostgreSQL Live DB Integration Tests', () => {
  let dbReady = true;
  let server: http.Server;
  let baseUrl = '';

  const createdUserIds: string[] = [];
  const createdPropertyIds: string[] = [];
  const createdRoomIds: string[] = [];
  const createdContractIds: string[] = [];
  const createdTicketIds: string[] = [];

  const uploadedPublicIds: string[] = [];
  const deletedPublicIds: string[] = [];

  const originalUploadStream = mediaService.uploadStream.bind(mediaService);
  const originalDeleteResource = mediaService.deleteResource.bind(mediaService);

  const uniqueBase = Date.now() % 10_000_000;
  let phoneSeq = 0;
  function nextPhone(): string {
    phoneSeq += 1;
    return `09${String(uniqueBase).padStart(7, '0').slice(-6)}${String(phoneSeq).padStart(2, '0')}`;
  }

  async function createTestUser(role: 'TENANT' | 'LANDLORD', label: string) {
    const idx = createdUserIds.length + 1;
    const user = await prisma.user.create({
      data: {
        fullName: `${label} ${idx}`,
        email: `rt-int-${uniqueBase}-${idx}-${Math.random().toString(36).slice(2, 7)}@rentmate.test`,
        phone: nextPhone(),
        passwordHash: 'test-only-hash',
        role,
        accountStatus: 'ACTIVE',
      },
    });
    createdUserIds.push(user.id);
    return user;
  }

  async function createTestPropertyAndRooms(params: {
    landlordId: string;
    primaryTenant1Id: string;
    primaryTenant2Id?: string;
    contract1Status?: string;
  }) {
    const property = await prisma.property.create({
      data: {
        landlordId: params.landlordId,
        name: `Repair Test Property ${uniqueBase}-${createdPropertyIds.length + 1}`,
        address: '123 Repair Test Street, Thu Duc',
        status: 'ACTIVE',
      },
    });
    createdPropertyIds.push(property.id);

    const room1 = await prisma.room.create({
      data: {
        propertyId: property.id,
        roomCode: `P.${createdRoomIds.length + 101}`,
        areaM2: 25,
        maxOccupants: 4,
        monthlyRent: 3500000,
        depositRequired: 3500000,
        electricityRate: 3500,
        waterRate: 20000,
        occupancyStatus: 'OCCUPIED',
        visibilityStatus: 'VISIBLE',
      },
    });
    createdRoomIds.push(room1.id);

    const contract1 = await prisma.contract.create({
      data: {
        roomId: room1.id,
        tenantId: params.primaryTenant1Id,
        startDate: new Date('2026-11-01'),
        endDate: new Date('2027-11-01'),
        status: params.contract1Status ?? CONTRACT_STATUS.ACTIVE,
        rentSnapshot: 3500000,
        depositSnapshot: 3500000,
        electricityRate: 3500,
        waterRate: 20000,
        activatedAt: new Date('2026-11-01T08:00:00.000Z'),
      },
    });
    createdContractIds.push(contract1.id);

    let room2 = null;
    let contract2 = null;
    if (params.primaryTenant2Id) {
      room2 = await prisma.room.create({
        data: {
          propertyId: property.id,
          roomCode: `P.${createdRoomIds.length + 102}`,
          areaM2: 20,
          maxOccupants: 2,
          monthlyRent: 3000000,
          depositRequired: 3000000,
          electricityRate: 3500,
          waterRate: 20000,
          occupancyStatus: 'OCCUPIED',
          visibilityStatus: 'VISIBLE',
        },
      });
      createdRoomIds.push(room2.id);

      contract2 = await prisma.contract.create({
        data: {
          roomId: room2.id,
          tenantId: params.primaryTenant2Id,
          startDate: new Date('2026-11-01'),
          endDate: new Date('2027-11-01'),
          status: CONTRACT_STATUS.ACTIVE,
          rentSnapshot: 3000000,
          depositSnapshot: 3000000,
          electricityRate: 3500,
          waterRate: 20000,
          activatedAt: new Date('2026-11-01T08:00:00.000Z'),
        },
      });
      createdContractIds.push(contract2.id);
    }

    return { property, room1, contract1, room2, contract2 };
  }

  function buildFormWithImages(
    fields: Record<string, string>,
    imageCount: number,
  ): FormData {
    const form = new FormData();
    for (const [key, val] of Object.entries(fields)) {
      form.append(key, val);
    }
    for (let i = 0; i < imageCount; i += 1) {
      form.append(
        'attachments',
        new Blob([VALID_PNG_BYTES], { type: 'image/png' }),
        `img-${i + 1}.png`,
      );
    }
    return form;
  }

  async function apiJson(
    method: string,
    urlPath: string,
    userId: string,
    body?: Record<string, unknown>,
  ) {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${signAccessToken(userId)}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json()) as Record<string, any>;
    return { status: res.status, body: json };
  }

  async function apiForm(
    method: string,
    urlPath: string,
    userId: string,
    form: FormData,
  ) {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${signAccessToken(userId)}`,
      },
      body: form,
    });
    const json = (await res.json()) as Record<string, any>;
    return { status: res.status, body: json };
  }

  before(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbReady = false;
      return;
    }

    mediaService.uploadStream = async (_buf, options) => {
      const publicId = options.publicId ?? `test-pub-${uploadedPublicIds.length + 1}`;
      uploadedPublicIds.push(publicId);
      return {
        secureUrl: `https://res.cloudinary.com/demo/image/upload/v1/${publicId}.webp`,
        publicId,
      };
    };
    mediaService.deleteResource = async (publicId) => {
      deletedPublicIds.push(publicId);
      return true;
    };

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    uploadedPublicIds.length = 0;
    deletedPublicIds.length = 0;
  });

  after(async () => {
    mediaService.uploadStream = originalUploadStream;
    mediaService.deleteResource = originalDeleteResource;

    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    if (!dbReady) return;

    const dbTicketIds =
      createdPropertyIds.length > 0
        ? (
            await prisma.repairTicket.findMany({
              where: { propertyId: { in: createdPropertyIds } },
              select: { id: true },
            })
          ).map((t) => t.id)
        : [];
    const allTicketIds = Array.from(new Set([...createdTicketIds, ...dbTicketIds]));

    if (allTicketIds.length > 0) {
      await prisma.auditLog.deleteMany({
        where: { entityId: { in: allTicketIds } },
      });
      await prisma.repairAttachment.deleteMany({
        where: { ticketId: { in: allTicketIds } },
      });
      await prisma.repairTicket.deleteMany({
        where: { id: { in: allTicketIds } },
      });
    }
    if (createdUserIds.length > 0) {
      await prisma.notification.deleteMany({
        where: { recipientId: { in: createdUserIds } },
      });
    }
    if (createdContractIds.length > 0) {
      await prisma.contractResident.deleteMany({
        where: { contractId: { in: createdContractIds } },
      });
      await prisma.contract.deleteMany({
        where: { id: { in: createdContractIds } },
      });
    }
    if (createdRoomIds.length > 0) {
      await prisma.room.deleteMany({
        where: { id: { in: createdRoomIds } },
      });
    }
    if (createdPropertyIds.length > 0) {
      await prisma.property.deleteMany({
        where: { id: { in: createdPropertyIds } },
      });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }
  });

  test('1. Tạo sự cố (BR-10): Chủ HĐ & Người ở cùng ACTIVE, Phòng riêng & Khu vực chung, Anti-IDOR', async (t) => {
    if (!dbReady) return t.skip('PostgreSQL is not available');

    const landlord = await createTestUser('LANDLORD', 'Landlord 1');
    const primaryA = await createTestUser('TENANT', 'Primary A1');
    const coResB = await createTestUser('TENANT', 'CoRes B1');
    const formerRes = await createTestUser('TENANT', 'Former 1');
    const otherRoomTenant = await createTestUser('TENANT', 'Other Room 1');
    const terminatedTenant = await createTestUser('TENANT', 'Terminated 1');

    const { property, room1, contract1, room2 } = await createTestPropertyAndRooms({
      landlordId: landlord.id,
      primaryTenant1Id: primaryA.id,
      primaryTenant2Id: otherRoomTenant.id,
    });
    const termProp = await createTestPropertyAndRooms({
      landlordId: landlord.id,
      primaryTenant1Id: terminatedTenant.id,
      contract1Status: CONTRACT_STATUS.TERMINATED,
    });

    await prisma.contractResident.createMany({
      data: [
        { contractId: contract1.id, userId: coResB.id, leftAt: null },
        { contractId: contract1.id, userId: formerRes.id, leftAt: new Date() },
      ],
    });

    // Primary A creates room ticket with 2 PNGs -> 201
    const rPrimary = await apiForm(
      'POST',
      '/api/v1/repair-tickets',
      primaryA.id,
      buildFormWithImages(
        {
          roomId: room1.id,
          title: 'Máy lạnh chảy nước phòng P101',
          description: 'Máy lạnh nhỏ nước xuống sàn suốt đêm qua',
          priority: REPAIR_TICKET_PRIORITY.HIGH,
        },
        2,
      ),
    );
    assert.equal(rPrimary.status, 201);
    createdTicketIds.push(rPrimary.body.id);
    assert.equal(rPrimary.body.status, REPAIR_TICKET_STATUS.OPEN);
    assert.equal(rPrimary.body.attachmentsByStage.INITIAL.length, 2);

    const dbTicket = await prisma.repairTicket.findUnique({
      where: { id: rPrimary.body.id },
      include: { attachments: true },
    });
    assert.equal(dbTicket?.attachments.length, 2);

    const notif = await prisma.notification.findFirst({
      where: { recipientId: landlord.id, eventType: NOTIFICATION_EVENT_TYPE.REPAIR_TICKET_CREATED },
    });
    assert.ok(notif);

    const audit = await prisma.auditLog.findFirst({
      where: { entityId: rPrimary.body.id, action: 'REPAIR_TICKET_CREATED' },
    });
    assert.ok(audit);

    // Co-Resident B creates room ticket & common-area ticket -> both 201
    const rCoRoom = await apiForm(
      'POST',
      '/api/v1/repair-tickets',
      coResB.id,
      buildFormWithImages(
        {
          roomId: room1.id,
          title: 'Bóng đèn nhà vệ sinh nhấp nháy',
          description: 'Đèn LED nhà vệ sinh chập chờn khi bật công tắc',
        },
        1,
      ),
    );
    assert.equal(rCoRoom.status, 201);
    createdTicketIds.push(rCoRoom.body.id);

    const rCoCommon = await apiForm(
      'POST',
      '/api/v1/repair-tickets',
      coResB.id,
      buildFormWithImages(
        {
          propertyId: property.id,
          title: 'Cổng chính khu trọ kẹt khóa',
          description: 'Khóa từ cổng chính không tự chốt khi đóng cửa',
        },
        1,
      ),
    );
    assert.equal(rCoCommon.status, 201);
    createdTicketIds.push(rCoCommon.body.id);
    assert.equal(rCoCommon.body.room, null);

    // Anti-IDOR: otherRoomTenant cannot create ticket for room1 -> 404 & 0 Cloudinary calls
    const beforeUploads = uploadedPublicIds.length;
    const rIdorRoom = await apiForm(
      'POST',
      '/api/v1/repair-tickets',
      otherRoomTenant.id,
      buildFormWithImages(
        {
          roomId: room1.id,
          title: 'Báo cáo chéo phòng',
          description: 'Thử gửi báo cáo vào phòng không thuê',
        },
        1,
      ),
    );
    assert.equal(rIdorRoom.status, 404);
    assert.equal(rIdorRoom.body.code, 'ROOM_NOT_FOUND');
    assert.equal(uploadedPublicIds.length, beforeUploads);

    // Former co-resident (leftAt != null) & terminated tenant -> 404
    const rFormer = await apiForm(
      'POST',
      '/api/v1/repair-tickets',
      formerRes.id,
      buildFormWithImages(
        {
          roomId: room1.id,
          title: 'Cựu cư dân gửi sự cố',
          description: 'Đã rời phòng nhưng thử tạo phiếu sự cố',
        },
        1,
      ),
    );
    assert.equal(rFormer.status, 404);

    const rTerm = await apiForm(
      'POST',
      '/api/v1/repair-tickets',
      terminatedTenant.id,
      buildFormWithImages(
        {
          roomId: termProp.room1.id,
          title: 'HĐ đã thanh lý gửi sự cố',
          description: 'Hợp đồng đã kết thúc nhưng thử tạo phiếu',
        },
        1,
      ),
    );
    assert.equal(rTerm.status, 404);
  });

  test('2. Q1 & Q7: Phòng riêng nhiều thành viên ACTIVE, rời phòng cắt cả GET lẫn nghiệm thu 404, khu vực chung chỉ createdById nghiệm thu', async (t) => {
    if (!dbReady) return t.skip('PostgreSQL is not available');

    const landlord = await createTestUser('LANDLORD', 'Landlord 2');
    const primaryA = await createTestUser('TENANT', 'Primary A2');
    const coResB = await createTestUser('TENANT', 'CoRes B2');
    const coResC = await createTestUser('TENANT', 'CoRes C2');
    const otherRoomTenant = await createTestUser('TENANT', 'Other Room 2');

    const { property, room1, contract1 } = await createTestPropertyAndRooms({
      landlordId: landlord.id,
      primaryTenant1Id: primaryA.id,
      primaryTenant2Id: otherRoomTenant.id,
    });
    await prisma.contractResident.createMany({
      data: [
        { contractId: contract1.id, userId: coResB.id, leftAt: null },
        { contractId: contract1.id, userId: coResC.id, leftAt: null },
      ],
    });

    // Primary A creates room ticket -> Landlord accepts & completes
    const createdRoomTicket = await apiForm(
      'POST',
      '/api/v1/repair-tickets',
      primaryA.id,
      buildFormWithImages(
        {
          roomId: room1.id,
          title: 'Ổ cắm điện phòng bị lỏng',
          description: 'Ổ cắm gần bàn học bị đánh lửa nhẹ khi cắm sạc',
        },
        1,
      ),
    );
    assert.equal(createdRoomTicket.status, 201);
    const ticketId1 = createdRoomTicket.body.id as string;
    createdTicketIds.push(ticketId1);

    const rAccept = await apiJson('PATCH', `/api/v1/repair-tickets/${ticketId1}/accept`, landlord.id, {
      resolutionPlan: 'Thay mặt ổ cắm mới đạt chuẩn',
      scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    assert.equal(rAccept.status, 200);

    const rComplete = await apiForm(
      'PATCH',
      `/api/v1/repair-tickets/${ticketId1}/complete`,
      landlord.id,
      buildFormWithImages({ repairCost: '150000', costBearer: REPAIR_COST_BEARER.LANDLORD }, 1),
    );
    assert.equal(rComplete.status, 200);

    // Check Q7: ACCEPT & COMPLETE notifications sent to A, B, C
    const acceptNotifs = await prisma.notification.findMany({
      where: {
        eventType: NOTIFICATION_EVENT_TYPE.REPAIR_TICKET_ACCEPTED,
        recipientId: { in: [primaryA.id, coResB.id, coResC.id] },
      },
    });
    assert.equal(acceptNotifs.length, 3);

    const completeNotifs = await prisma.notification.findMany({
      where: {
        eventType: NOTIFICATION_EVENT_TYPE.REPAIR_TICKET_COMPLETED,
        recipientId: { in: [primaryA.id, coResB.id, coResC.id] },
      },
    });
    assert.equal(completeNotifs.length, 3);

    // Co-Resident B confirms completion -> 200 CLOSED; Q7 notify Landlord + A + C (NOT B)
    const rConfirmB = await apiJson(
      'PATCH',
      `/api/v1/repair-tickets/${ticketId1}/confirm-completion`,
      coResB.id,
    );
    assert.equal(rConfirmB.status, 200);
    assert.equal(rConfirmB.body.status, REPAIR_TICKET_STATUS.CLOSED);

    const closedNotifs = await prisma.notification.findMany({
      where: {
        eventType: NOTIFICATION_EVENT_TYPE.REPAIR_TICKET_CLOSED,
        recipientId: { in: [landlord.id, primaryA.id, coResB.id, coResC.id] },
      },
    });
    const closedRecipientIds = closedNotifs.map((n) => n.recipientId).sort();
    assert.deepEqual(closedRecipientIds, [landlord.id, primaryA.id, coResC.id].sort());

    // Co-Resident B creates a room ticket AND a common-area ticket, then leaves the room
    const bRoomTicket = await apiForm(
      'POST',
      '/api/v1/repair-tickets',
      coResB.id,
      buildFormWithImages(
        {
          roomId: room1.id,
          title: 'Cửa sổ bị xệ bản lề',
          description: 'Cửa sổ phòng khó đóng chặt khi trời mưa gió',
        },
        1,
      ),
    );
    assert.equal(bRoomTicket.status, 201);
    const bRoomTicketId = bRoomTicket.body.id as string;
    createdTicketIds.push(bRoomTicketId);

    const bCommonTicket = await apiForm(
      'POST',
      '/api/v1/repair-tickets',
      coResB.id,
      buildFormWithImages(
        {
          propertyId: property.id,
          title: 'Đèn cầu thang tầng 1 tắt',
          description: 'Đèn chiếu sáng cầu thang tầng 1 không sáng',
        },
        1,
      ),
    );
    assert.equal(bCommonTicket.status, 201);
    const bCommonTicketId = bCommonTicket.body.id as string;
    createdTicketIds.push(bCommonTicketId);

    // Common area: otherRoomTenant CAN view GET /:id -> 200, but CANNOT confirm -> 404
    const otherGetCommon = await apiJson(
      'GET',
      `/api/v1/repair-tickets/${bCommonTicketId}`,
      otherRoomTenant.id,
    );
    assert.equal(otherGetCommon.status, 200);

    await apiJson('PATCH', `/api/v1/repair-tickets/${bCommonTicketId}/accept`, landlord.id, {
      resolutionPlan: 'Thay bóng đèn cầu thang',
      scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await apiForm(
      'PATCH',
      `/api/v1/repair-tickets/${bCommonTicketId}/complete`,
      landlord.id,
      buildFormWithImages({}, 1),
    );

    const otherConfirmCommon = await apiJson(
      'PATCH',
      `/api/v1/repair-tickets/${bCommonTicketId}/confirm-completion`,
      otherRoomTenant.id,
    );
    assert.equal(otherConfirmCommon.status, 404);
    assert.equal(otherConfirmCommon.body.code, 'REPAIR_TICKET_NOT_FOUND');

    // Landlord accepts & completes bRoomTicket
    await apiJson('PATCH', `/api/v1/repair-tickets/${bRoomTicketId}/accept`, landlord.id, {
      resolutionPlan: 'Chỉnh bản lề cửa sổ',
      scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await apiForm(
      'PATCH',
      `/api/v1/repair-tickets/${bRoomTicketId}/complete`,
      landlord.id,
      buildFormWithImages({}, 1),
    );

    // B leaves the room!
    await prisma.contractResident.update({
      where: {
        contractId_userId: {
          contractId: contract1.id,
          userId: coResB.id,
        },
      },
      data: { leftAt: new Date() },
    });

    // Q1: B loses GET list, GET detail, confirm, reject (all 404/empty) even though B is createdById
    const bList = await apiJson('GET', '/api/v1/repair-tickets', coResB.id);
    assert.equal(bList.status, 200);
    assert.equal(bList.body.items.length, 0);

    for (const id of [bRoomTicketId, bCommonTicketId]) {
      const rGet = await apiJson('GET', `/api/v1/repair-tickets/${id}`, coResB.id);
      assert.equal(rGet.status, 404);
      assert.equal(rGet.body.code, 'REPAIR_TICKET_NOT_FOUND');

      const rConf = await apiJson('PATCH', `/api/v1/repair-tickets/${id}/confirm-completion`, coResB.id);
      assert.equal(rConf.status, 404);

      const rRej = await apiJson('PATCH', `/api/v1/repair-tickets/${id}/reject-completion`, coResB.id, {
        reason: 'Không còn cư trú nhưng thử từ chối',
      });
      assert.equal(rRej.status, 404);
    }

    // Meanwhile active Primary Tenant A can still view and confirm bRoomTicket!
    const aGet = await apiJson('GET', `/api/v1/repair-tickets/${bRoomTicketId}`, primaryA.id);
    assert.equal(aGet.status, 200);
    const aConfirm = await apiJson(
      'PATCH',
      `/api/v1/repair-tickets/${bRoomTicketId}/confirm-completion`,
      primaryA.id,
    );
    assert.equal(aConfirm.status, 200);
    assert.equal(aConfirm.body.status, REPAIR_TICKET_STATUS.CLOSED);
  });

  test('3. Vòng đời đầy đủ & Reopen 0 ảnh / có ảnh, Reset chi phí (Q2, Q3, Q4, Q5) + Luật 72h', async (t) => {
    if (!dbReady) return t.skip('PostgreSQL is not available');

    const landlord = await createTestUser('LANDLORD', 'Landlord 3');
    const tenant = await createTestUser('TENANT', 'Tenant 3');
    const { room1 } = await createTestPropertyAndRooms({
      landlordId: landlord.id,
      primaryTenant1Id: tenant.id,
    });

    const created = await apiForm(
      'POST',
      '/api/v1/repair-tickets',
      tenant.id,
      buildFormWithImages(
        {
          roomId: room1.id,
          title: 'Bồn cầu bị rỉ nước liên tục',
          description: 'Nước chảy liên tục xuống bồn cầu gây ồn và tốn nước',
        },
        1,
      ),
    );
    assert.equal(created.status, 201);
    const ticketId = created.body.id as string;
    createdTicketIds.push(ticketId);

    // 72h escalation rule check
    const before72h = await apiJson('GET', `/api/v1/repair-tickets/${ticketId}`, tenant.id);
    assert.equal(before72h.body.canEscalateToComplaint, false);

    await prisma.repairTicket.update({
      where: { id: ticketId },
      data: { createdAt: new Date(Date.now() - 73 * 60 * 60 * 1000) },
    });
    const after72hDetail = await apiJson('GET', `/api/v1/repair-tickets/${ticketId}`, tenant.id);
    assert.equal(after72hDetail.body.canEscalateToComplaint, true);
    const after72hList = await apiJson('GET', '/api/v1/repair-tickets', tenant.id);
    assert.equal(after72hList.body.items[0].canEscalateToComplaint, true);

    // Q5: scheduledAt = now - 10m -> 400; now - 3m -> 200
    const badAccept = await apiJson('PATCH', `/api/v1/repair-tickets/${ticketId}/accept`, landlord.id, {
      resolutionPlan: 'Thay phao bồn cầu',
      scheduledAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    assert.equal(badAccept.status, 400);

    const okAccept = await apiJson('PATCH', `/api/v1/repair-tickets/${ticketId}/accept`, landlord.id, {
      resolutionPlan: 'Thay phao bồn cầu',
      scheduledAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
    });
    assert.equal(okAccept.status, 200);
    assert.equal(okAccept.body.canEscalateToComplaint, false);

    // Complete 1 with cost 450000
    const complete1 = await apiForm(
      'PATCH',
      `/api/v1/repair-tickets/${ticketId}/complete`,
      landlord.id,
      buildFormWithImages({ repairCost: '450000', costBearer: REPAIR_COST_BEARER.LANDLORD }, 2),
    );
    assert.equal(complete1.status, 200);
    assert.equal(complete1.body.repairCost, 450000);
    assert.ok(complete1.body.autoCloseAt);

    // Reject 1 with JSON 0 images (Q2, Q3)
    const reject1 = await apiJson('PATCH', `/api/v1/repair-tickets/${ticketId}/reject-completion`, tenant.id, {
      reason: 'Nước vẫn còn chảy rỉ nhẹ sau khi thay phao lần một',
    });
    assert.equal(reject1.status, 200);
    assert.equal(reject1.body.status, REPAIR_TICKET_STATUS.IN_PROGRESS);
    assert.equal(reject1.body.completedAt, null);
    assert.equal(reject1.body.repairCost, null);
    assert.equal(reject1.body.costBearer, null);
    assert.equal(reject1.body.attachmentsByStage.REOPEN_EVIDENCE.length, 0);
    assert.equal(reject1.body.reopenHistory.length, 1);
    assert.equal(
      reject1.body.latestRejectionReason,
      'Nước vẫn còn chảy rỉ nhẹ sau khi thay phao lần một',
    );

    // Complete 2 & Reject 2 with multipart 2 REOPEN_EVIDENCE images
    const complete2 = await apiForm(
      'PATCH',
      `/api/v1/repair-tickets/${ticketId}/complete`,
      landlord.id,
      buildFormWithImages({ repairCost: '0', costBearer: REPAIR_COST_BEARER.TENANT }, 1),
    );
    assert.equal(complete2.status, 200);
    assert.equal(complete2.body.repairCost, 0);

    const reject2 = await apiForm(
      'PATCH',
      `/api/v1/repair-tickets/${ticketId}/reject-completion`,
      tenant.id,
      buildFormWithImages(
        { reason: 'Gioăng cao su vẫn hở nên nước còn rỉ ra chân bồn cầu' },
        2,
      ),
    );
    assert.equal(reject2.status, 200);
    assert.equal(reject2.body.attachmentsByStage.REOPEN_EVIDENCE.length, 2);
    assert.equal(reject2.body.reopenHistory.length, 2);
    assert.equal(
      reject2.body.latestRejectionReason,
      'Gioăng cao su vẫn hở nên nước còn rỉ ra chân bồn cầu',
    );
  });

  test('4. Luật tự động đóng 5 ngày (Q6, Q8, Q9): Lazy reject + Cloudinary rollback, Lazy confirm, Race Promise.all, List lazy-check', async (t) => {
    if (!dbReady) return t.skip('PostgreSQL is not available');

    const landlord = await createTestUser('LANDLORD', 'Landlord 4');
    const tenant = await createTestUser('TENANT', 'Tenant 4');
    const { property, room1 } = await createTestPropertyAndRooms({
      landlordId: landlord.id,
      primaryTenant1Id: tenant.id,
    });

    const sixDaysAgo = new Date(Date.now() - (5 * 24 * 60 + 1) * 60 * 1000);

    async function createStaleTicket(title: string) {
      const ticket = await prisma.repairTicket.create({
        data: {
          propertyId: property.id,
          roomId: room1.id,
          createdById: tenant.id,
          title,
          description: 'Mô tả sự cố kiểm thử tự động đóng sau 5 ngày',
          priority: REPAIR_TICKET_PRIORITY.MEDIUM,
          status: REPAIR_TICKET_STATUS.AWAITING_CONFIRMATION,
          resolutionPlan: 'Đã sửa chữa',
          scheduledAt: new Date(sixDaysAgo.getTime() - 3600_000),
          completedAt: sixDaysAgo,
        },
      });
      createdTicketIds.push(ticket.id);
      return ticket;
    }

    // #1: reject-completion when already > 5 days at preCheck -> commits CLOSED without uploading, returns 409 REPAIR_TICKET_AUTO_CLOSED
    const t1 = await createStaleTicket('Ticket quá hạn #1 (reject preCheck)');
    const beforeUploadCount = uploadedPublicIds.length;
    const beforeDeleteCount = deletedPublicIds.length;
    const rRejectExpired = await apiForm(
      'PATCH',
      `/api/v1/repair-tickets/${t1.id}/reject-completion`,
      tenant.id,
      buildFormWithImages({ reason: 'Gửi phản hồi khi đã quá 5 ngày nghiệm thu' }, 1),
    );
    assert.equal(rRejectExpired.status, 409);
    assert.equal(rRejectExpired.body.code, 'REPAIR_TICKET_AUTO_CLOSED');
    assert.equal(uploadedPublicIds.length, beforeUploadCount);
    assert.equal(deletedPublicIds.length, beforeDeleteCount);

    const dbT1 = await prisma.repairTicket.findUnique({ where: { id: t1.id } });
    assert.equal(dbT1?.status, REPAIR_TICKET_STATUS.CLOSED);
    const auditT1 = await prisma.auditLog.findMany({
      where: { entityId: t1.id, action: 'REPAIR_TICKET_AUTO_CLOSED' },
    });
    assert.equal(auditT1.length, 1);

    // #1b: reject-completion expires AFTER preCheck (during Cloudinary upload) -> commits CLOSED, deletes uploaded image, returns 409
    const t1Race = await prisma.repairTicket.create({
      data: {
        propertyId: property.id,
        roomId: room1.id,
        createdById: tenant.id,
        title: 'Ticket quá hạn #1b (reject race during upload)',
        description: 'Mô tả sự cố kiểm thử quá hạn trong lúc đang upload ảnh',
        priority: REPAIR_TICKET_PRIORITY.MEDIUM,
        status: REPAIR_TICKET_STATUS.AWAITING_CONFIRMATION,
        resolutionPlan: 'Đã sửa chữa',
        scheduledAt: new Date(sixDaysAgo.getTime() - 3600_000),
        completedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
      },
    });
    createdTicketIds.push(t1Race.id);

    const beforeRaceUploadCount = uploadedPublicIds.length;
    const beforeRaceDeleteCount = deletedPublicIds.length;
    const prevUpload = mediaService.uploadStream;
    mediaService.uploadStream = async (buffer, options) => {
      const result = await prevUpload(buffer, options);
      await prisma.repairTicket.update({
        where: { id: t1Race.id },
        data: { completedAt: sixDaysAgo },
      });
      return result;
    };
    try {
      const rRejectRace = await apiForm(
        'PATCH',
        `/api/v1/repair-tickets/${t1Race.id}/reject-completion`,
        tenant.id,
        buildFormWithImages({ reason: 'Gửi phản hồi đúng lúc quá 5 ngày trong khi upload' }, 1),
      );
      assert.equal(rRejectRace.status, 409);
      assert.equal(rRejectRace.body.code, 'REPAIR_TICKET_AUTO_CLOSED');
      assert.equal(uploadedPublicIds.length, beforeRaceUploadCount + 1);
      assert.equal(deletedPublicIds.length, beforeRaceDeleteCount + 1);
    } finally {
      mediaService.uploadStream = prevUpload;
    }

    const dbT1Race = await prisma.repairTicket.findUnique({ where: { id: t1Race.id } });
    assert.equal(dbT1Race?.status, REPAIR_TICKET_STATUS.CLOSED);
    const auditT1Race = await prisma.auditLog.findMany({
      where: { entityId: t1Race.id, action: 'REPAIR_TICKET_AUTO_CLOSED' },
    });
    assert.equal(auditT1Race.length, 1);

    // #2: confirm-completion after 5 days -> commits CLOSED, returns 409 REPAIR_TICKET_AUTO_CLOSED
    const t2 = await createStaleTicket('Ticket quá hạn #2 (confirm)');
    const rConfirmExpired = await apiJson(
      'PATCH',
      `/api/v1/repair-tickets/${t2.id}/confirm-completion`,
      tenant.id,
    );
    assert.equal(rConfirmExpired.status, 409);
    assert.equal(rConfirmExpired.body.code, 'REPAIR_TICKET_AUTO_CLOSED');
    const dbT2 = await prisma.repairTicket.findUnique({ where: { id: t2.id } });
    assert.equal(dbT2?.status, REPAIR_TICKET_STATUS.CLOSED);

    // #3: Race condition Promise.all([autoCloseStaleRepairTickets, PATCH /confirm-completion]) -> closed once
    const t3 = await createStaleTicket('Ticket quá hạn #3 (race)');
    const [cronRes, httpRes] = await Promise.all([
      autoCloseStaleRepairTickets({ extraWhere: { id: t3.id } }),
      apiJson('PATCH', `/api/v1/repair-tickets/${t3.id}/confirm-completion`, tenant.id),
    ]);
    assert.equal(httpRes.status, 409);
    assert.ok(
      httpRes.body.code === 'REPAIR_TICKET_AUTO_CLOSED' ||
        httpRes.body.code === 'REPAIR_TICKET_ALREADY_CLOSED',
      `Expected REPAIR_TICKET_AUTO_CLOSED or REPAIR_TICKET_ALREADY_CLOSED, got ${String(httpRes.body.code)}`,
    );
    assert.equal(cronRes.scanned, 1);
    assert.equal(cronRes.closedCount + cronRes.skippedCount, 1);
    assert.equal(cronRes.failedCount, 0);

    const auditT3 = await prisma.auditLog.findMany({
      where: { entityId: t3.id, action: 'REPAIR_TICKET_AUTO_CLOSED' },
    });
    assert.equal(auditT3.length, 1);

    const notifsT3 = await prisma.notification.findMany({
      where: {
        recipientId: { in: [landlord.id, tenant.id] },
        eventType: NOTIFICATION_EVENT_TYPE.REPAIR_TICKET_CLOSED,
        payload: { path: ['relatedEntityId'], equals: t3.id },
      },
    });
    assert.equal(notifsT3.length, 2);

    // #4: Scoped list lazy-check (Q9) closes t4 and includes it in ?status=CLOSED immediately
    const t4 = await createStaleTicket('Ticket quá hạn #4 (list lazy-check)');
    const rListClosed = await apiJson(
      'GET',
      `/api/v1/repair-tickets?status=CLOSED&propertyId=${property.id}`,
      tenant.id,
    );
    assert.equal(rListClosed.status, 200);
    const listIds = (rListClosed.body.items as Array<{ id: string }>).map((i) => i.id);
    assert.ok(listIds.includes(t4.id), 'Ticket #4 phải được tự động đóng và xuất hiện trong ?status=CLOSED');

    // Second cron run on this property finds 0 stale tickets
    const secondCron = await autoCloseStaleRepairTickets({
      extraWhere: { propertyId: property.id },
    });
    assert.deepEqual(secondCron, {
      scanned: 0,
      closedCount: 0,
      skippedCount: 0,
      failedCount: 0,
    });
  });
});
