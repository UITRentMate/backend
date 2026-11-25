// Nạp biến môi trường an toàn từ file .env nếu có, không gây lỗi nếu file chưa tồn tại
try {
  process.loadEnvFile();
} catch {
  // Bỏ qua lỗi nếu file .env chưa được tạo hoặc môi trường đã set sẵn biến
}

export const PORT = Number(process.env.PORT) || 5000;
export const DATABASE_URL = process.env.DATABASE_URL || '';

const DEFAULT_FRONTEND_RESET_PASSWORD_URL = 'http://localhost:5173/reset-password';

/**
 * Trả về URL trang đặt lại mật khẩu ở frontend, đọc từ biến môi trường hoặc fallback khi không ở production.
 */
export function getFrontendResetPasswordUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.FRONTEND_RESET_PASSWORD_URL?.trim();
  if (!raw) {
    if (env.NODE_ENV === 'production') {
      throw new Error('FRONTEND_RESET_PASSWORD_URL is required in production');
    }
    return DEFAULT_FRONTEND_RESET_PASSWORD_URL;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid FRONTEND_RESET_PASSWORD_URL: "${raw}"`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid FRONTEND_RESET_PASSWORD_URL protocol: "${parsed.protocol}"`);
  }

  return raw;
}
