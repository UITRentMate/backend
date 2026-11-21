import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { Prisma } from '@prisma/client';

import {
  CONTRACT_STATUS,
  DEPOSIT_RECEIPT_STATUS,
  LANDLORD_APPLICATION_STATUS,
  NOTIFICATION_EVENT_TYPE,
  REPAIR_COST_BEARER,
  REPAIR_TICKET_PRIORITY,
  REPAIR_TICKET_STATUS,
} from '../src/common/constants/phase3-status';
import { recordAuditLog } from '../src/common/utils/audit-log.util';
import {
  createNotification,
  createNotificationsBatch,
} from '../src/common/utils/notification.util';
import { prisma } from '../src/infrastructure/database/prisma';

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

test('Live DB: Phase 3 shared schema, 3 partial unique indexes, audit log & notification helpers', async (t) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    t.skip('PostgreSQL is not available');
    return;
  }

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const userIds: string[] = [];
  let propertyId: string | undefined;
  let roomId: string | undefined;

  try {
    // 1. Tạo User với các cột hồ sơ mới (avatarUrl, avatarCloudinaryPublicId, dateOfBirth, address)
    const landlord = await prisma.user.create({
      data: {
        fullName: 'Phase3 Schema Landlord',
        email: `p3-owner-${suffix}@rentmate.test`,
        phone: `09${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`,
        passwordHash: 'test-only',
        role: 'LANDLORD',
        accountStatus: 'ACTIVE',
        avatarUrl: 'https://res.cloudinary.com/demo/image/upload/avatar.png',
        avatarCloudinaryPublicId: `rentmate/avatars/test-${suffix}`,
        dateOfBirth: new Date('1998-05-15'),
        address: 'Thủ Đức, TP.HCM',
      },
    });
    userIds.push(landlord.id);

    const tenant = await prisma.user.create({
      data: {
        fullName: 'Phase3 Schema Tenant',
        email: `p3-tenant-${suffix}@rentmate.test`,
        phone: `09${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`,
        passwordHash: 'test-only',
        role: 'TENANT',
        accountStatus: 'ACTIVE',
      },
    });
    userIds.push(tenant.id);

    assert.equal(landlord.address, 'Thủ Đức, TP.HCM');

    // 2. Kiểm tra bảng password_reset_tokens
    const tokenHash = crypto.createHash('sha256').update(`token-${suffix}`).digest('hex');
    const resetToken = await prisma.passwordResetToken.create({
      data: {
        userId: tenant.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });
    assert.equal(resetToken.usedAt, null);

    // 3. Kiểm tra Partial Unique Index #1: uq_landlord_applications_pending_user
    const rejectedApp = await prisma.landlordApplication.create({
      data: {
        userId: tenant.id,
        cccdFrontUrl: 'https://example.com/front1.jpg',
        cccdBackUrl: 'https://example.com/back1.jpg',
        ownershipProofUrl: 'https://example.com/proof1.jpg',
        status: LANDLORD_APPLICATION_STATUS.REJECTED,
        rejectionReason: 'Ảnh mờ',
      },
    });
    assert.equal(rejectedApp.status, LANDLORD_APPLICATION_STATUS.REJECTED);

    // Sau khi REJECTED vẫn tạo được 1 hồ sơ PENDING
    await prisma.landlordApplication.create({
      data: {
        userId: tenant.id,
        cccdFrontUrl: 'https://example.com/front2.jpg',
        cccdBackUrl: 'https://example.com/back2.jpg',
        ownershipProofUrl: 'https://example.com/proof2.jpg',
        status: LANDLORD_APPLICATION_STATUS.PENDING,
      },
    });

    // Hồ sơ PENDING thứ 2 cùng user phải bị chặn P2002 ở tầng PostgreSQL
    await assert.rejects(
      () =>
        prisma.landlordApplication.create({
          data: {
            userId: tenant.id,
            cccdFrontUrl: 'https://example.com/front3.jpg',
            cccdBackUrl: 'https://example.com/back3.jpg',
            ownershipProofUrl: 'https://example.com/proof3.jpg',
            status: LANDLORD_APPLICATION_STATUS.PENDING,
          },
        }),
      (err) => isUniqueConstraintError(err),
    );

    // 4. Tạo Property & Room để test Partial Unique Index #2 (uq_contracts_live_room) & #3 (uq_deposit_receipts_pending_contract)
    const property = await prisma.property.create({
      data: {
        landlordId: landlord.id,
        name: `Phase3 Property ${suffix}`,
        address: 'Linh Trung, Thủ Đức',
        status: 'ACTIVE',
      },
    });
    propertyId = property.id;

    const room = await prisma.room.create({
      data: {
        propertyId,
        roomCode: `P3-${suffix}`,
        areaM2: 22,
        maxOccupants: 2,
        monthlyRent: 3500000,
        depositRequired: 3500000,
        electricityRate: 3500,
        waterRate: 15000,
        occupancyStatus: 'HELD',
        visibilityStatus: 'VISIBLE',
      },
    });
    roomId = room.id;

    // Cho phép nhiều hợp đồng CANCELLED/EXPIRED trên cùng 1 phòng
    await prisma.contract.create({
      data: {
        roomId,
        tenantId: tenant.id,
        startDate: new Date('2026-12-01'),
        endDate: new Date('2027-06-01'),
        status: CONTRACT_STATUS.CANCELLED,
        rentSnapshot: 3500000,
        depositSnapshot: 3500000,
        electricityRate: 3500,
        waterRate: 15000,
        cancellationReason: 'Khách đổi ý',
      },
    });

    // Tạo 1 hợp đồng live (PENDING_TENANT_CONFIRMATION - 27 ký tự) kèm các cột mới
    const liveContract = await prisma.contract.create({
      data: {
        roomId,
        tenantId: tenant.id,
        startDate: new Date('2026-12-01'),
        endDate: new Date('2027-06-01'),
        status: CONTRACT_STATUS.PENDING_TENANT_CONFIRMATION,
        rentSnapshot: 3500000,
        depositSnapshot: 3500000,
        electricityRate: 3500,
        waterRate: 15000,
        holdExpiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
        tenantNote: 'Đề nghị ghi rõ phí gửi xe',
      },
    });
    assert.equal(liveContract.status, CONTRACT_STATUS.PENDING_TENANT_CONFIRMATION);

    // Hợp đồng live thứ 2 trên cùng phòng phải bị chặn P2002 ở tầng PostgreSQL
    await assert.rejects(
      () =>
        prisma.contract.create({
          data: {
            roomId: room.id,
            tenantId: tenant.id,
            startDate: new Date('2026-12-01'),
            endDate: new Date('2027-06-01'),
            status: CONTRACT_STATUS.DRAFT,
            rentSnapshot: 3500000,
            depositSnapshot: 3500000,
            electricityRate: 3500,
            waterRate: 15000,
          },
        }),
      (err) => isUniqueConstraintError(err),
    );

    // 5. Kiểm tra Partial Unique Index #3: uq_deposit_receipts_pending_contract
    await prisma.depositReceipt.create({
      data: {
        contractId: liveContract.id,
        amount: 3500000,
        proofUrl: 'https://example.com/receipt-rejected.jpg',
        status: DEPOSIT_RECEIPT_STATUS.REJECTED,
        rejectionReason: 'Sai nội dung chuyển khoản',
      },
    });

    await prisma.depositReceipt.create({
      data: {
        contractId: liveContract.id,
        amount: 3500000,
        proofUrl: 'https://example.com/receipt-pending-1.jpg',
        status: DEPOSIT_RECEIPT_STATUS.PENDING,
      },
    });

    await assert.rejects(
      () =>
        prisma.depositReceipt.create({
          data: {
            contractId: liveContract.id,
            amount: 3500000,
            proofUrl: 'https://example.com/receipt-pending-2.jpg',
            status: DEPOSIT_RECEIPT_STATUS.PENDING,
          },
        }),
      (err) => isUniqueConstraintError(err),
    );

    // 6. Kiểm tra 4 cột mới trên repair_tickets
    const ticket = await prisma.repairTicket.create({
      data: {
        propertyId,
        roomId,
        createdById: tenant.id,
        title: 'Hỏng máy lạnh',
        description: 'Máy lạnh không lạnh và chảy nước',
        priority: REPAIR_TICKET_PRIORITY.HIGH,
        status: REPAIR_TICKET_STATUS.OPEN,
        resolutionPlan: 'Gọi thợ vệ sinh và bơm gas',
        repairCost: 350000,
        costBearer: REPAIR_COST_BEARER.LANDLORD,
      },
    });
    assert.equal(ticket.priority, REPAIR_TICKET_PRIORITY.HIGH);
    assert.equal(ticket.costBearer, REPAIR_COST_BEARER.LANDLORD);

    // 7. Kiểm tra recordAuditLog & createNotification trong cùng $transaction (commit & rollback)
    const txEntityId = liveContract.id;
    await prisma.$transaction(async (tx) => {
      await recordAuditLog(tx, {
        actorId: landlord.id,
        entityType: 'CONTRACT',
        entityId: txEntityId,
        action: 'PHASE3_TX_COMMIT_TEST',
        oldData: { status: 'DRAFT' },
        newData: { status: 'PENDING_TENANT_CONFIRMATION' },
      });
      await createNotification(tx, {
        recipientId: tenant.id,
        title: 'Hợp đồng nháp đã được gửi',
        eventType: NOTIFICATION_EVENT_TYPE.CONTRACT_DRAFT_SENT,
        payload: { contractId: txEntityId },
      });
      await createNotificationsBatch(tx, [
        {
          recipientId: landlord.id,
          title: 'Thông báo batch test',
          eventType: NOTIFICATION_EVENT_TYPE.RENTAL_REQUEST_APPROVED,
        },
      ]);
    });

    const committedLogs = await prisma.auditLog.count({
      where: { entityId: txEntityId, action: 'PHASE3_TX_COMMIT_TEST' },
    });
    assert.equal(committedLogs, 1);

    const committedNotifs = await prisma.notification.count({
      where: { recipientId: { in: [tenant.id, landlord.id] } },
    });
    assert.equal(committedNotifs, 2);

    // Test rollback nguyên tử khi transaction thất bại
    await assert.rejects(
      () =>
        prisma.$transaction(async (tx) => {
          await recordAuditLog(tx, {
            actorId: landlord.id,
            entityType: 'CONTRACT',
            entityId: txEntityId,
            action: 'PHASE3_TX_ROLLBACK_TEST',
          });
          await createNotification(tx, {
            recipientId: tenant.id,
            title: 'Should rollback',
            eventType: NOTIFICATION_EVENT_TYPE.DEPOSIT_CONFIRMED,
          });
          throw new Error('Force rollback');
        }),
      /Force rollback/,
    );

    const rolledBackLogs = await prisma.auditLog.count({
      where: { entityId: txEntityId, action: 'PHASE3_TX_ROLLBACK_TEST' },
    });
    assert.equal(rolledBackLogs, 0);
  } finally {
    if (userIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } }).catch(() => {});
      await prisma.notification
        .deleteMany({ where: { recipientId: { in: userIds } } })
        .catch(() => {});
    }
    if (propertyId) {
      await prisma.repairTicket.deleteMany({ where: { propertyId } }).catch(() => {});
    }
    if (roomId) {
      const contracts = await prisma.contract.findMany({
        where: { roomId },
        select: { id: true },
      });
      const contractIds = contracts.map((c) => c.id);
      if (contractIds.length > 0) {
        await prisma.depositReceipt
          .deleteMany({ where: { contractId: { in: contractIds } } })
          .catch(() => {});
        await prisma.contract
          .deleteMany({ where: { id: { in: contractIds } } })
          .catch(() => {});
      }
      await prisma.room.delete({ where: { id: roomId } }).catch(() => {});
    }
    if (propertyId) {
      await prisma.property.delete({ where: { id: propertyId } }).catch(() => {});
    }
    if (userIds.length > 0) {
      await prisma.landlordApplication
        .deleteMany({ where: { userId: { in: userIds } } })
        .catch(() => {});
      await prisma.passwordResetToken
        .deleteMany({ where: { userId: { in: userIds } } })
        .catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    }
  }
});
