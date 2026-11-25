import { Router } from 'express';
import { requireRole } from '../../common/middleware/require-role';
import { RepairTicketController } from './repair-ticket.controller';
import { uploadRepairAttachments } from './repair-ticket.upload';

export const repairTicketRouter = Router();

repairTicketRouter.post(
  '/api/v1/repair-tickets',
  requireRole('TENANT'),
  uploadRepairAttachments({ minFiles: 1, maxFiles: 5 }),
  RepairTicketController.createRepairTicket,
);

repairTicketRouter.get(
  '/api/v1/repair-tickets',
  requireRole('TENANT', 'LANDLORD'),
  RepairTicketController.listRepairTickets,
);

repairTicketRouter.get(
  '/api/v1/repair-tickets/:ticketId',
  requireRole('TENANT', 'LANDLORD'),
  RepairTicketController.getRepairTicketDetail,
);

repairTicketRouter.patch(
  '/api/v1/repair-tickets/:ticketId/accept',
  requireRole('LANDLORD'),
  RepairTicketController.acceptRepairTicket,
);

repairTicketRouter.patch(
  '/api/v1/repair-tickets/:ticketId/complete',
  requireRole('LANDLORD'),
  uploadRepairAttachments({ minFiles: 1, maxFiles: 5 }),
  RepairTicketController.completeRepairTicket,
);

repairTicketRouter.patch(
  '/api/v1/repair-tickets/:ticketId/confirm-completion',
  requireRole('TENANT'),
  RepairTicketController.confirmCompletion,
);

repairTicketRouter.patch(
  '/api/v1/repair-tickets/:ticketId/reject-completion',
  requireRole('TENANT'),
  uploadRepairAttachments({ minFiles: 0, maxFiles: 3, allowJsonWithoutFiles: true }),
  RepairTicketController.rejectCompletion,
);
