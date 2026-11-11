import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';

const passwordSchema = z.string()
  .min(8, 'Mật khẩu cần 8 đến 72 byte UTF-8, chữ hoa, chữ thường, số và ký tự đặc biệt')
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Mật khẩu cần 8 đến 72 byte UTF-8, chữ hoa, chữ thường, số và ký tự đặc biệt')
  .refine((value) => /[a-z]/.test(value), 'Mật khẩu cần 8 đến 72 byte UTF-8, chữ hoa, chữ thường, số và ký tự đặc biệt')
  .refine((value) => /[A-Z]/.test(value), 'Mật khẩu cần 8 đến 72 byte UTF-8, chữ hoa, chữ thường, số và ký tự đặc biệt')
  .refine((value) => /\d/.test(value), 'Mật khẩu cần 8 đến 72 byte UTF-8, chữ hoa, chữ thường, số và ký tự đặc biệt')
  .refine((value) => /[^A-Za-z0-9]/.test(value), 'Mật khẩu cần 8 đến 72 byte UTF-8, chữ hoa, chữ thường, số và ký tự đặc biệt');

const registerSchema = z.object({
  fullName: z.string().trim().min(1, 'Họ tên phải từ 1 đến 150 ký tự').max(150, 'Họ tên phải từ 1 đến 150 ký tự'),
  email: z.string().trim().toLowerCase().email('Email không hợp lệ').max(255, 'Email không hợp lệ'),
  phone: z.string().trim().regex(/^0\d{9}$/, 'Số điện thoại phải gồm 10 chữ số và bắt đầu bằng 0'),
  password: passwordSchema,
  confirmPassword: z.string(),
  acceptedTerms: z.literal(true, { error: 'Cần đồng ý điều khoản' }),
}).strict().refine((input) => input.password === input.confirmPassword, {
  path: ['confirmPassword'],
  message: 'Mật khẩu xác nhận không khớp',
});

const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1, 'Cần email hoặc số điện thoại'),
  password: z.string().min(1, 'Cần mật khẩu').refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Mật khẩu không được vượt 72 byte UTF-8'),
}).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const errors: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const field = issue.path.join('.') || '_';
    (errors[field] ??= []).push(issue.message);
  }
  throw new ApiError(400, 'VALIDATION_ERROR', 'Dữ liệu không hợp lệ', errors);
}

export function parseRegister(body: unknown) {
  const { fullName, email, phone, password } = parse(registerSchema, body);
  return { fullName, email, phone, password };
}

export function parseLogin(body: unknown) {
  return parse(loginSchema, body);
}
