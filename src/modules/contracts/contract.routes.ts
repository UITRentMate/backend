import { Router } from 'express';

import { requireRole } from '../../common/middleware/require-role';
import { cancelContractHoldController } from './contract.controller';

export const contractRouter = Router();

contractRouter.patch(
  '/api/v1/contracts/:contractId/cancel-hold',
  requireRole('LANDLORD', 'TENANT'),
  cancelContractHoldController,
);
