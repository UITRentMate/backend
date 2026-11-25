import { Router } from 'express';
import { defaultEmailSender, type EmailSender } from '../../infrastructure/mail/email.service';
import {
  createForgotPasswordController,
  loginController,
  logoutController,
  refreshController,
  registerController,
} from './auth.controller';

export interface AuthRoutesDependencies {
  emailSender?: EmailSender;
}

/**
 * Khởi tạo router cho phân hệ Auth, cho phép inject EmailSender khi kiểm thử.
 */
export function createAuthRoutes(deps: AuthRoutesDependencies = {}): Router {
  const router = Router();
  const forgotPasswordHandler = createForgotPasswordController(deps.emailSender ?? defaultEmailSender);

  router.post('/register', registerController);
  router.post('/login', loginController);
  router.post('/refresh', refreshController);
  router.post('/logout', logoutController);
  router.post('/forgot-password', forgotPasswordHandler);

  return router;
}

export const authRoutes = createAuthRoutes();
