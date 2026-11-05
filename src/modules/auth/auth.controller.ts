import type { Request, Response } from 'express';
import { HttpError } from '../../common/http-error';
import { login, logout, refreshSession, register } from './auth.service';
import { readRefreshCookie, REFRESH_COOKIE, refreshCookieOptions } from './auth.security';
import { parseLogin, parseRegister } from './auth.validation';

export async function registerController(req: Request, res: Response) {
  const user = await register(parseRegister(req.body));
  res.status(201).json(user);
}

export async function loginController(req: Request, res: Response) {
  const result = await login(parseLogin(req.body));
  res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions());
  res.status(200).json(result.body);
}

export async function refreshController(req: Request, res: Response) {
  try {
    const token = readRefreshCookie(req.header('Cookie'));
    if (!token) {
      res.cookie(REFRESH_COOKIE, '', refreshCookieOptions(0));
      res.status(401).json({ success: false, code: 'UNAUTHORIZED', message: 'Refresh token không hợp lệ' });
      return;
    }
    const result = await refreshSession(token);
    res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions(result.maxAge));
    res.status(200).json(result.body);
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      res.cookie(REFRESH_COOKIE, '', refreshCookieOptions(0));
    }
    throw error;
  }
}

export async function logoutController(req: Request, res: Response) {
  await logout(readRefreshCookie(req.header('Cookie')));
  res.cookie(REFRESH_COOKIE, '', refreshCookieOptions(0));
  res.status(200).json({ message: 'Đăng xuất thành công' });
}
