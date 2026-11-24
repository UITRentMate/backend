import { Router } from 'express';
import { requireAuth } from '../../common/require-auth';
import { requireActiveUser } from '../../common/middleware/require-role';
import { uploadSingleImage } from '../media/media.middleware';
import {
  getMeController,
  updateMeController,
  uploadAvatarController,
} from './users.controller';

export const usersRoutes = Router();

usersRoutes.get('/me', requireAuth, requireActiveUser, getMeController);
usersRoutes.put('/me', requireAuth, requireActiveUser, updateMeController);
usersRoutes.post(
  '/me/avatar',
  requireAuth,
  requireActiveUser,
  uploadSingleImage('avatar'),
  uploadAvatarController,
);
