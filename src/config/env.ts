// Nạp biến môi trường an toàn từ file .env nếu có, không gây lỗi nếu file chưa tồn tại
try {
  process.loadEnvFile();
} catch {
  // Bỏ qua lỗi nếu file .env chưa được tạo hoặc môi trường đã set sẵn biến
}

export const PORT = Number(process.env.PORT) || 5000;
export const DATABASE_URL = process.env.DATABASE_URL || '';
