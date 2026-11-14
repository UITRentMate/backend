import { Router } from 'express';
import { requireAuth } from '../../common/require-auth';
import { requireActiveUser } from '../../common/middleware/require-role';
import { getMeController } from './users.controller';

export const usersRoutes = Router();
usersRoutes.get('/me', requireAuth, requireActiveUser, getMeController);
