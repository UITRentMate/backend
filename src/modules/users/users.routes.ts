import { Router } from 'express';
import { requireAuth } from '../../common/require-auth';
import { getMeController } from './users.controller';

export const usersRoutes = Router();
usersRoutes.get('/me', requireAuth, getMeController);
