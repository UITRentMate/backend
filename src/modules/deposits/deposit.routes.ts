import { Router } from 'express';

import { requireRole } from '../../common/middleware/require-role';
import {
  confirmDepositReceiptController, listDepositReceiptsController,
  rejectDepositReceiptController, submitDepositReceiptController,
} from './deposit.controller';
import { uploadDepositProof, validateDepositContractId } from './deposit.validation';

export const depositRouter = Router();

depositRouter.post('/api/v1/contracts/:contractId/deposit-receipts',
  requireRole('TENANT'), validateDepositContractId, uploadDepositProof, submitDepositReceiptController);
depositRouter.get('/api/v1/contracts/:contractId/deposit-receipts',
  requireRole('TENANT', 'LANDLORD'), listDepositReceiptsController);
depositRouter.patch('/api/v1/deposit-receipts/:receiptId/confirm',
  requireRole('LANDLORD'), confirmDepositReceiptController);
depositRouter.patch('/api/v1/deposit-receipts/:receiptId/reject',
  requireRole('LANDLORD'), rejectDepositReceiptController);
