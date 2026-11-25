import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import nodemailer from 'nodemailer';

import { Prisma } from '@prisma/client';
import {
  CONTRACT_STATUS,
  DEPOSIT_RECEIPT_STATUS,
  getEventTypesByCategory,
  getNotificationCategory,
  LANDLORD_APPLICATION_STATUS,
  NOTIFICATION_CATEGORY,
  NOTIFICATION_CATEGORY_BY_EVENT,
  NOTIFICATION_EVENT_TYPE,
  REPAIR_ATTACHMENT_STAGE,
  REPAIR_COST_BEARER,
  REPAIR_TICKET_PRIORITY,
  REPAIR_TICKET_STATUS,
  RESIDENT_INVITATION_STATUS,
} from '../src/common/constants/phase3-status';
import {
  createNotification,
  createNotificationsBatch,
  normalizeNotificationTitle,
} from '../src/common/utils/notification.util';
import {
  buildPasswordResetEmailContent,
  loadSmtpConfigFromEnv,
  NodemailerEmailService,
  SMTP_TIMEOUTS_MS,
} from '../src/infrastructure/mail/email.service';
import {
  clearRegisteredPhase3Jobs,
  listRegisteredPhase3Jobs,
  registerPhase3Job,
  startPhase3Timers,
  stopPhase3Timers,
} from '../src/infrastructure/scheduler/phase3-timers';

describe('Phase 3 Shared Status Constants', () => {
  test('mọi hằng số trạng thái đều vừa khít kích thước VARCHAR trong PostgreSQL', () => {
    for (const val of Object.values(CONTRACT_STATUS)) {
      assert.ok(val.length <= 32, `CONTRACT_STATUS "${val}" vượt quá VARCHAR(32)`);
    }
    for (const val of Object.values(DEPOSIT_RECEIPT_STATUS)) {
      assert.ok(val.length <= 20, `DEPOSIT_RECEIPT_STATUS "${val}" vượt quá VARCHAR(20)`);
    }
    for (const val of Object.values(LANDLORD_APPLICATION_STATUS)) {
      assert.ok(val.length <= 20, `LANDLORD_APPLICATION_STATUS "${val}" vượt quá VARCHAR(20)`);
    }
    for (const val of Object.values(RESIDENT_INVITATION_STATUS)) {
      assert.ok(val.length <= 20, `RESIDENT_INVITATION_STATUS "${val}" vượt quá VARCHAR(20)`);
    }
    for (const val of Object.values(REPAIR_TICKET_STATUS)) {
      assert.ok(val.length <= 28, `REPAIR_TICKET_STATUS "${val}" vượt quá VARCHAR(28)`);
    }
    for (const val of Object.values(REPAIR_TICKET_PRIORITY)) {
      assert.ok(val.length <= 20, `REPAIR_TICKET_PRIORITY "${val}" vượt quá VARCHAR(20)`);
    }
    for (const val of Object.values(REPAIR_COST_BEARER)) {
      assert.ok(val.length <= 20, `REPAIR_COST_BEARER "${val}" vượt quá VARCHAR(20)`);
    }
    for (const val of Object.values(REPAIR_ATTACHMENT_STAGE)) {
      assert.ok(val.length <= 25, `REPAIR_ATTACHMENT_STAGE "${val}" vượt quá VARCHAR(25)`);
    }
    for (const val of Object.values(NOTIFICATION_EVENT_TYPE)) {
      assert.ok(val.length <= 40, `NOTIFICATION_EVENT_TYPE "${val}" vượt quá VARCHAR(40)`);
      assert.ok(
        val in NOTIFICATION_CATEGORY_BY_EVENT,
        `NOTIFICATION_EVENT_TYPE "${val}" chưa được ánh xạ trong NOTIFICATION_CATEGORY_BY_EVENT`,
      );
    }
  });

  test('NOTIFICATION_EVENT_TYPE có đủ 5 hằng số cho phân hệ cư trú (BE-P3-08) và đều <= 40 ký tự', () => {
    const residentEvents = [
      NOTIFICATION_EVENT_TYPE.RESIDENT_INVITATION_RECEIVED,
      NOTIFICATION_EVENT_TYPE.RESIDENT_JOINED,
      NOTIFICATION_EVENT_TYPE.RESIDENT_INVITATION_REJECTED,
      NOTIFICATION_EVENT_TYPE.RESIDENT_INVITATION_CANCELLED,
      NOTIFICATION_EVENT_TYPE.RESIDENT_REMOVED,
    ];

    assert.deepEqual(residentEvents, [
      'RESIDENT_INVITATION_RECEIVED',
      'RESIDENT_JOINED',
      'RESIDENT_INVITATION_REJECTED',
      'RESIDENT_INVITATION_CANCELLED',
      'RESIDENT_REMOVED',
    ]);

    for (const eventType of residentEvents) {
      assert.ok(eventType.length <= 40, `${eventType} vượt quá VARCHAR(40)`);
    }
  });

  test('ánh xạ danh mục thông báo (category) & chuẩn hóa tiêu đề hoạt động chính xác', () => {
    assert.equal(
      getNotificationCategory(NOTIFICATION_EVENT_TYPE.DEPOSIT_CONFIRMED),
      NOTIFICATION_CATEGORY.FINANCE,
    );
    assert.equal(
      getNotificationCategory(NOTIFICATION_EVENT_TYPE.VIEWING_APPOINTMENT_CREATED),
      NOTIFICATION_CATEGORY.BOOKING_CONTRACT,
    );
    assert.equal(
      getNotificationCategory(NOTIFICATION_EVENT_TYPE.RESIDENT_INVITATION_REJECTED),
      NOTIFICATION_CATEGORY.BOOKING_CONTRACT,
    );
    assert.equal(
      getNotificationCategory(NOTIFICATION_EVENT_TYPE.RESIDENT_INVITATION_CANCELLED),
      NOTIFICATION_CATEGORY.BOOKING_CONTRACT,
    );
    assert.equal(
      getNotificationCategory(NOTIFICATION_EVENT_TYPE.REPAIR_TICKET_CREATED),
      NOTIFICATION_CATEGORY.REPAIR,
    );
    assert.equal(
      getNotificationCategory('UNKNOWN_FUTURE_EVENT'),
      NOTIFICATION_CATEGORY.SYSTEM,
    );

    const repairEvents = getEventTypesByCategory(NOTIFICATION_CATEGORY.REPAIR);
    assert.ok(repairEvents.includes(NOTIFICATION_EVENT_TYPE.REPAIR_TICKET_CREATED));
    assert.ok(!repairEvents.includes(NOTIFICATION_EVENT_TYPE.DEPOSIT_CONFIRMED));

    const longTitle = `  ${'A'.repeat(250)}  `;
    assert.equal(normalizeNotificationTitle(longTitle).length, 200);
    assert.equal(normalizeNotificationTitle('  Thông báo mới  '), 'Thông báo mới');

    // Emoji nằm đúng ranh giới 200 UTF-16 code units không được tách đôi surrogate pair
    const titleWithBoundaryEmoji = `${'A'.repeat(199)}🏠BC`;
    const normalizedEmojiTitle = normalizeNotificationTitle(titleWithBoundaryEmoji);
    assert.equal([...normalizedEmojiTitle].length, 200);
    assert.ok(normalizedEmojiTitle.endsWith('🏠'));
    assert.equal(Buffer.from(normalizedEmojiTitle, 'utf8').toString('utf8'), normalizedEmojiTitle);
  });

  test('createNotification và createNotificationsBatch chuẩn hóa title và map payload null sang Prisma.JsonNull', async () => {
    let singleArgs: any;
    let batchArgs: any;
    const fakeDb: any = {
      notification: {
        create: async (args: any) => {
          singleArgs = args;
          return { id: 'n-1', ...args.data };
        },
        createMany: async (args: any) => {
          batchArgs = args;
          return { count: args.data.length };
        },
      },
    };

    const longTitle = `${'X'.repeat(199)}🎉YZ`;
    await createNotification(fakeDb, {
      recipientId: 'user-1',
      title: longTitle,
      eventType: NOTIFICATION_EVENT_TYPE.DEPOSIT_CONFIRMED,
      payload: null,
    });

    assert.equal([...singleArgs.data.title].length, 200);
    assert.ok(singleArgs.data.title.endsWith('🎉'));
    assert.equal(singleArgs.data.payload, Prisma.JsonNull);

    await createNotificationsBatch(fakeDb, [
      {
        recipientId: 'user-2',
        title: `  ${'Y'.repeat(210)}  `,
        eventType: NOTIFICATION_EVENT_TYPE.RENTAL_REQUEST_AUTO_REJECTED,
        payload: null,
      },
    ]);

    assert.equal([...batchArgs.data[0].title].length, 200);
    assert.equal(batchArgs.data[0].payload, Prisma.JsonNull);
  });
});

describe('Nodemailer Email Service Config & Content', () => {
  test('loadSmtpConfigFromEnv ném lỗi rõ ràng khi thiếu biến SMTP', () => {
    assert.throws(
      () => loadSmtpConfigFromEnv({}),
      /Thiếu cấu hình SMTP/,
    );
  });

  test('loadSmtpConfigFromEnv đọc đúng cấu hình SMTP hợp lệ', () => {
    const config = loadSmtpConfigFromEnv({
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_PORT: '587',
      SMTP_SECURE: 'false',
      SMTP_USER: 'rentmate@example.com',
      SMTP_PASS: 'app-password',
      SMTP_FROM: 'UIT RentMate <rentmate@example.com>',
    });

    assert.equal(config.host, 'smtp.gmail.com');
    assert.equal(config.port, 587);
    assert.equal(config.secure, false);
    assert.equal(config.user, 'rentmate@example.com');
    assert.equal(config.from, 'UIT RentMate <rentmate@example.com>');
  });

  test('NodemailerEmailService khởi tạo lazy và báo lỗi cấu hình khi gọi gửi với env trống', async () => {
    const service = new NodemailerEmailService({});
    await assert.rejects(
      () =>
        service.sendPasswordResetEmail({
          to: 'user@example.com',
          fullName: 'Nguyen Van A',
          resetUrl: 'http://localhost:5173/reset-password?token=abc',
          expiresInMinutes: 15,
        }),
      /Thiếu cấu hình SMTP/,
    );
  });

  test('buildPasswordResetEmailContent escape HTML và chèn đủ link + thời hạn', () => {
    const content = buildPasswordResetEmailContent({
      to: 'user@example.com',
      fullName: '<script>alert(1)</script>',
      resetUrl: 'http://localhost:5173/reset-password?token=123&src=mail',
      expiresInMinutes: 15,
    });

    assert.match(content.subject, /UIT RentMate/);
    assert.match(content.text, /15 phút/);
    assert.match(content.text, /token=123&src=mail/);
    assert.ok(!content.html.includes('<script>'));
    assert.ok(content.html.includes('&lt;script&gt;'));
  });

  test('NodemailerEmailService cấu hình connectionTimeout, greetingTimeout và socketTimeout rõ ràng', async () => {
    let capturedTransportOptions: any;
    let capturedMailOptions: any;
    const originalCreateTransport = nodemailer.createTransport;

    (nodemailer as any).createTransport = (options: any) => {
      capturedTransportOptions = options;
      return {
        sendMail: async (mailOptions: any) => {
          capturedMailOptions = mailOptions;
          return { messageId: 'test-msg-id' };
        },
      };
    };

    try {
      const service = new NodemailerEmailService({
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '587',
        SMTP_SECURE: 'false',
        SMTP_USER: 'mailer@example.com',
        SMTP_PASS: 'app-pass',
        SMTP_FROM: 'UIT RentMate <mailer@example.com>',
      });

      await service.sendPasswordResetEmail({
        to: 'user@example.com',
        fullName: 'Test User',
        resetUrl: 'http://localhost:5173/reset-password?token=abc',
        expiresInMinutes: 15,
      });

      assert.equal(capturedTransportOptions.connectionTimeout, SMTP_TIMEOUTS_MS.CONNECTION);
      assert.equal(capturedTransportOptions.greetingTimeout, SMTP_TIMEOUTS_MS.GREETING);
      assert.equal(capturedTransportOptions.socketTimeout, SMTP_TIMEOUTS_MS.SOCKET);
      assert.equal(capturedTransportOptions.connectionTimeout, 10_000);
      assert.equal(capturedTransportOptions.greetingTimeout, 10_000);
      assert.equal(capturedTransportOptions.socketTimeout, 15_000);
      assert.equal(capturedMailOptions.to, 'user@example.com');
      assert.equal(capturedMailOptions.from, 'UIT RentMate <mailer@example.com>');
    } finally {
      (nodemailer as any).createTransport = originalCreateTransport;
    }
  });
});

describe('Phase 3 Timer Runner', () => {
  test('không kích hoạt timer khi NODE_ENV === test và quản lý job an toàn', () => {
    clearRegisteredPhase3Jobs();
    let invoked = 0;

    registerPhase3Job({
      name: 'test-job',
      intervalMs: 10,
      handler: async () => {
        invoked += 1;
      },
    });

    assert.equal(listRegisteredPhase3Jobs().length, 1);
    const stop = startPhase3Timers({ NODE_ENV: 'test' });
    stop();
    stopPhase3Timers();
    clearRegisteredPhase3Jobs();

    assert.equal(invoked, 0);
    assert.equal(listRegisteredPhase3Jobs().length, 0);
  });
});
