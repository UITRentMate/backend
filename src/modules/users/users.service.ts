import { ApiError } from '../../common/errors/api-error';
import { prisma } from '../../infrastructure/database/prisma';

export async function getCurrentUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, fullName: true, email: true, phone: true, role: true, accountStatus: true },
  });
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'Không tìm thấy tài khoản');
  if (user.accountStatus !== 'ACTIVE') throw new ApiError(403, 'ACCOUNT_LOCKED', 'Tài khoản không thể truy cập');
  return {
    userId: user.id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.accountStatus,
  };
}
