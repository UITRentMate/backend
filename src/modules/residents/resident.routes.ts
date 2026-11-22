import { Router } from 'express';
import { requireRole } from '../../common/middleware/require-role';
import { ResidentController } from './resident.controller';

export const residentRouter = Router();

residentRouter.get(
  '/api/v1/contracts/:contractId/residents',
  requireRole('TENANT', 'LANDLORD'),
  ResidentController.getContractResidents,
);

residentRouter.post(
  '/api/v1/contracts/:contractId/invitations',
  requireRole('TENANT', 'LANDLORD'),
  ResidentController.createInvitation,
);

residentRouter.delete(
  '/api/v1/contracts/:contractId/residents/:userId',
  requireRole('TENANT', 'LANDLORD'),
  ResidentController.removeResident,
);

residentRouter.get(
  '/api/v1/resident-invitations',
  requireRole('TENANT'),
  ResidentController.listMyInvitations,
);

residentRouter.patch(
  '/api/v1/resident-invitations/:invitationId/accept',
  requireRole('TENANT'),
  ResidentController.acceptInvitation,
);

residentRouter.patch(
  '/api/v1/resident-invitations/:invitationId/reject',
  requireRole('TENANT'),
  ResidentController.rejectInvitation,
);

residentRouter.patch(
  '/api/v1/resident-invitations/:invitationId/cancel',
  requireRole('TENANT', 'LANDLORD'),
  ResidentController.cancelInvitation,
);
