import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CONTRACT_STATUS,
  DEPOSIT_RECEIPT_STATUS,
  LANDLORD_APPLICATION_STATUS,
  NOTIFICATION_EVENT_TYPE,
  REPAIR_ATTACHMENT_STAGE,
  REPAIR_COST_BEARER,
  REPAIR_TICKET_PRIORITY,
  REPAIR_TICKET_STATUS,
  RESIDENT_INVITATION_STATUS,
} from '../src/common/constants/phase3-status';
import {
  buildPasswordResetEmailContent,
  loadSmtpConfigFromEnv,
  NodemailerEmailService,
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
