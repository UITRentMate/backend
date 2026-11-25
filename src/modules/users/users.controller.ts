import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../../common/errors/api-error';
import { REFRESH_COOKIE, refreshCookieOptions } from '../auth/auth.security';
import {
  changeMyPassword,
  getCurrentUser,
  updateCurrentUser,
  uploadMyAvatar,
} from './users.service';
import { validateChangePassword, validateUpdateUserProfile } from './users.validation';

export async function getMeController(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await getCurrentUser(res.locals.userId as string);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function updateMeController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = res.locals.userId as string;
    const input = validateUpdateUserProfile(req.body);
    const result = await updateCurrentUser(userId, input);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function uploadAvatarController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = res.locals.userId as string;
    const fileBuffer = req.file?.buffer;
    if (!fileBuffer) {
      throw new ApiError(400, 'FILE_REQUIRED', 'Vui lòng chọn file ảnh để tải lên');
    }
    const result = await uploadMyAvatar(userId, fileBuffer);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function changePasswordController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = res.locals.userId as string;
    const input = validateChangePassword(req.body);
    const result = await changeMyPassword(userId, input);
    res.cookie(REFRESH_COOKIE, '', refreshCookieOptions(0));
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}
