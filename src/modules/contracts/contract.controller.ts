import type { Request, Response } from 'express';

import { cancelContractHold } from './contract.service';
import { validateCancelContractHold } from './contract.validation';

export async function cancelContractHoldController(req: Request, res: Response): Promise<void> {
  const { contractId, reason } = validateCancelContractHold(req.params.contractId, req.body);
  res.status(200).json(await cancelContractHold(res.locals.currentUser!, contractId, reason));
}
