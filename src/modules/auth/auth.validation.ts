import { HttpError } from '../../common/http-error';

type RegisterInput = {
  fullName: string;
  email: string;
  phone: string;
  password: string;
};

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Dữ liệu không hợp lệ');
  }
  return body as Record<string, unknown>;
}

function rejectUnknown(body: Record<string, unknown>, allowed: string[], errors: Record<string, string[]>) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) errors[key] = ['Trường không được phép'];
  }
}

export function parseRegister(body: unknown): RegisterInput {
  const input = objectBody(body);
  const errors: Record<string, string[]> = {};
  rejectUnknown(input, ['fullName', 'email', 'phone', 'password', 'confirmPassword', 'acceptedTerms'], errors);
  const fullName = typeof input.fullName === 'string' ? input.fullName.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const phone = typeof input.phone === 'string' ? input.phone.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  if (!fullName || fullName.length > 150) errors.fullName = ['Họ tên phải từ 1 đến 150 ký tự'];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) errors.email = ['Email không hợp lệ'];
  if (!/^0\d{9}$/.test(phone)) errors.phone = ['Số điện thoại phải gồm 10 chữ số và bắt đầu bằng 0'];
  if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    errors.password = ['Mật khẩu cần 8 đến 72 byte UTF-8, chữ hoa, chữ thường, số và ký tự đặc biệt'];
  }
  if (input.confirmPassword !== password) errors.confirmPassword = ['Mật khẩu xác nhận không khớp'];
  if (input.acceptedTerms !== true) errors.acceptedTerms = ['Cần đồng ý điều khoản'];
  if (Object.keys(errors).length) throw new HttpError(400, 'VALIDATION_ERROR', 'Dữ liệu không hợp lệ', errors);
  return { fullName, email, phone, password };
}

export function parseLogin(body: unknown): { username: string; password: string } {
  const input = objectBody(body);
  const errors: Record<string, string[]> = {};
  rejectUnknown(input, ['username', 'password'], errors);
  const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  if (!username) errors.username = ['Cần email hoặc số điện thoại'];
  if (!password) errors.password = ['Cần mật khẩu'];
  else if (Buffer.byteLength(password, 'utf8') > 72) errors.password = ['Mật khẩu không được vượt 72 byte UTF-8'];
  if (Object.keys(errors).length) throw new HttpError(400, 'VALIDATION_ERROR', 'Dữ liệu không hợp lệ', errors);
  return { username, password };
}
