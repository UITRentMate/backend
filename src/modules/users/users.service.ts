import { ApiError } from '../../common/errors/api-error';
import { prisma } from '../../infrastructure/database/prisma';

export async function getCurrentUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, fullName: true, email: true, phone: true, role: true, accountStatus: true },
  });
  if (!user) throw new ApiError(401, 'UNAUTHORIZED', 'Tài khoản không tồn tại hoặc phiên đăng nhập không hợp lệ');
  if (user.accountStatus !== 'ACTIVE') throw new ApiError(403, 'ACCOUNT_LOCKED', 'Tài khoản đã bị khóa hoặc chưa kích hoạt');
  return {
    userId: user.id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.accountStatus,
  };
}
