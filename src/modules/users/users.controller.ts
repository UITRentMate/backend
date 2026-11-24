import type { NextFunction, Request, Response } from 'express';
import { getCurrentUser, updateCurrentUser } from './users.service';
import { validateUpdateUserProfile } from './users.validation';

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
