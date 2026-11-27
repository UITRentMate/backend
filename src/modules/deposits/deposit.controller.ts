import type { Request, Response } from 'express';

import { listDepositReceipts, reviewDepositReceipt, submitDepositReceipt } from './deposit.service';
import { validateDepositAmount, validateDepositId, validateDepositRejection } from './deposit.validation';

export async function submitDepositReceiptController(req: Request<{ contractId: string }>, res: Response): Promise<void> {
  const { contractId } = req.params;
  const amount = validateDepositAmount(req.body);
  const receipt = await submitDepositReceipt(res.locals.currentUser!.id, contractId, amount, req.file!.buffer);
  res.status(201).json(receipt);
}

export async function listDepositReceiptsController(req: Request, res: Response): Promise<void> {
  const contractId = validateDepositId(req.params.contractId, 'contractId');
  res.status(200).json(await listDepositReceipts(res.locals.currentUser!, contractId));
}

export async function confirmDepositReceiptController(req: Request, res: Response): Promise<void> {
  const receiptId = validateDepositId(req.params.receiptId, 'receiptId');
  res.status(200).json(await reviewDepositReceipt(res.locals.currentUser!.id, receiptId, {}));
}

export async function rejectDepositReceiptController(req: Request, res: Response): Promise<void> {
  const receiptId = validateDepositId(req.params.receiptId, 'receiptId');
  const rejectionReason = validateDepositRejection(req.body);
  res.status(200).json(await reviewDepositReceipt(res.locals.currentUser!.id, receiptId, { rejectionReason }));
}
