import '../../config/env';
import { prisma } from './prisma';

async function checkDatabaseConnection(): Promise<void> {
  console.log('--- KIỂM TRA KẾT NỐI POSTGRESQL (PRISMA CLIENT) ---');

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('✗ Lỗi: Biến môi trường DATABASE_URL chưa được thiết lập trong .env!');
    console.log('Vui lòng tạo file .env trong thư mục backend/ dựa theo .env.example');
    process.exit(1);
  }

  try {
    // Thực hiện truy vấn không thay đổi dữ liệu SELECT 1
    const result = await prisma.$queryRaw<Array<{ connected: number }>>`SELECT 1 as connected`;
    if (result && result.length > 0 && result[0].connected === 1) {
      console.log('✓ Kết nối PostgreSQL thành công! (Thao tác: SELECT 1 - OK)');
    } else {
      console.warn('! Kết nối trả về kết quả không mong đợi:', result);
    }
  } catch (error: unknown) {
    console.error('✗ Kết nối PostgreSQL thất bại!');
    if (error instanceof Error) {
      // Làm sạch thông báo lỗi, không để lộ credentials / mật khẩu
      const sanitized = error.message.replace(/postgresql:\/\/[^@]+@/, 'postgresql://***:***@');
      console.error('Chi tiết lỗi:', sanitized);
    }
    process.exit(1);
  } finally {
    await prisma.$disconnect();
    console.log('--- ĐÃ ĐÓNG KẾT NỐI AN TOÀN ---');
  }
}

checkDatabaseConnection();
