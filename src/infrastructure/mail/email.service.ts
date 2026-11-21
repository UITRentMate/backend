import nodemailer, { type Transporter } from 'nodemailer';

export interface SendPasswordResetEmailParams {
  to: string;
  fullName: string;
  resetUrl: string;
  expiresInMinutes: number;
}

export interface EmailSender {
  sendPasswordResetEmail(params: SendPasswordResetEmailParams): Promise<void>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export function loadSmtpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpConfig {
  const host = (env.SMTP_HOST ?? '').trim();
  const portRaw = (env.SMTP_PORT ?? '587').trim();
  const port = Number(portRaw);
  const secureRaw = (env.SMTP_SECURE ?? '').trim().toLowerCase();
  const secure = secureRaw === 'true' || (secureRaw === '' && port === 465);
  const user = (env.SMTP_USER ?? '').trim();
  const pass = (env.SMTP_PASS ?? '').trim();
  const from = (env.SMTP_FROM ?? user).trim();

  if (!host || !Number.isInteger(port) || port <= 0 || !user || !pass || !from) {
    throw new Error(
      'Thiếu cấu hình SMTP trong .env (yêu cầu SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM).',
    );
  }

  return { host, port, secure, user, pass, from };
}

export function buildPasswordResetEmailContent(params: SendPasswordResetEmailParams): {
  subject: string;
  text: string;
  html: string;
} {
  const safeName = params.fullName.trim() || 'bạn';
  const escapedName = safeName
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const escapedUrl = params.resetUrl
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');

  const subject = '[UIT RentMate] Hướng dẫn đặt lại mật khẩu';
  const text = [
    `Xin chào ${safeName},`,
    '',
    'Chúng tôi đã nhận được yêu cầu đặt lại mật khẩu cho tài khoản UIT RentMate của bạn.',
    `Vui lòng truy cập đường dẫn sau trong vòng ${params.expiresInMinutes} phút để đặt lại mật khẩu:`,
    params.resetUrl,
    '',
    'Nếu bạn không thực hiện yêu cầu này, vui lòng bỏ qua email này.',
  ].join('\n');

  const html = [
    `<p>Xin chào <strong>${escapedName}</strong>,</p>`,
    '<p>Chúng tôi đã nhận được yêu cầu đặt lại mật khẩu cho tài khoản <strong>UIT RentMate</strong> của bạn.</p>',
    `<p>Đường dẫn đặt lại mật khẩu có hiệu lực trong vòng <strong>${params.expiresInMinutes} phút</strong>:</p>`,
    `<p><a href="${escapedUrl}">${escapedUrl}</a></p>`,
    '<p>Nếu bạn không thực hiện yêu cầu này, vui lòng bỏ qua email này.</p>',
  ].join('');

  return { subject, text, html };
}

export class NodemailerEmailService implements EmailSender {
  private transporter: Transporter | null = null;
  private cachedFrom: string | null = null;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private getTransporter(): { transporter: Transporter; from: string } {
    if (this.transporter && this.cachedFrom) {
      return { transporter: this.transporter, from: this.cachedFrom };
    }

    const config = loadSmtpConfigFromEnv(this.env);
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.pass,
      },
    });
    this.cachedFrom = config.from;

    return { transporter: this.transporter, from: this.cachedFrom };
  }

  async sendPasswordResetEmail(params: SendPasswordResetEmailParams): Promise<void> {
    const { transporter, from } = this.getTransporter();
    const content = buildPasswordResetEmailContent(params);

    await transporter.sendMail({
      from,
      to: params.to,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });
  }
}

export const defaultEmailSender: EmailSender = new NodemailerEmailService();
