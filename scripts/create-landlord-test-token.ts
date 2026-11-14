import { prisma } from '../src/infrastructure/database/prisma';
import { signAccessToken } from '../src/modules/auth/auth.security';
import bcrypt from 'bcrypt';

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Lỗi bảo mật: Script tạo test token chỉ được chạy trong môi trường development/staging!');
    process.exit(1);
  }

  process.loadEnvFile();

  const landlordEmail = 'landlord.test@rentmate.vn';
  const passwordHash = await bcrypt.hash('Password@123', 10);

  // Tạo hoặc lấy tài khoản Chủ trọ test
  let landlord = await prisma.user.findUnique({
    where: { email: landlordEmail },
  });

  if (!landlord) {
    landlord = await prisma.user.create({
      data: {
        fullName: 'Chủ Trọ Mẫu (Test Swagger)',
        email: landlordEmail,
        phone: '0901234888',
        passwordHash,
        role: 'LANDLORD',
        accountStatus: 'ACTIVE',
      },
    });
    console.log('✓ Đã tạo mới tài khoản Chủ trọ test:', landlordEmail);
  } else {
    // Đảm bảo role là LANDLORD và ACTIVE
    if (landlord.role !== 'LANDLORD' || landlord.accountStatus !== 'ACTIVE') {
      landlord = await prisma.user.update({
        where: { id: landlord.id },
        data: { role: 'LANDLORD', accountStatus: 'ACTIVE' },
      });
    }
    console.log('✓ Sử dụng tài khoản Chủ trọ test hiện có:', landlordEmail);
  }

  const token = signAccessToken(landlord.id);
  console.log('\n======================================================');
  console.log('🔑 ACCESS TOKEN CHỦ TRỌ (DÙNG ĐỂ PASTE VÀO SWAGGER):');
  console.log('======================================================\n');
  console.log(token);
  console.log('\n======================================================\n');
}

main()
  .catch((err) => {
    console.error('Lỗi tạo token:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
