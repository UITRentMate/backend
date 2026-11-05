import { Router } from 'express';
import { loginController, logoutController, refreshController, registerController } from './auth.controller';

export const authRoutes = Router();
authRoutes.post('/register', registerController);
authRoutes.post('/login', loginController);
authRoutes.post('/refresh', refreshController);
authRoutes.post('/logout', logoutController);
