export const DEFAULT_VIEWING_DURATION_MINUTES = 30;

export const VIEWING_STATUS = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
} as const;

export type ViewingStatus = (typeof VIEWING_STATUS)[keyof typeof VIEWING_STATUS];

export interface CreateViewingAppointmentInput {
  roomId: string;
  proposedSlots: string[];
  contactPhone?: string;
  note?: string | null;
}

export interface ConfirmViewingAppointmentInput {
  selectedSlotId: string;
}

export interface RejectViewingAppointmentInput {
  reason: string;
}

export interface CancelViewingAppointmentInput {
  reason: string;
}

export interface ViewingAppointmentListQuery {
  status?: ViewingStatus;
  roomId?: string;
  fromDate?: Date;
  toDate?: Date;
  page: number;
  pageSize: number;
}

export interface ViewingSlotDTO {
  id: string;
  startAt: string;
}

export interface ViewingAppointmentItemDTO {
  appointmentId: string;
  roomId: string;
  status: string;
  contactPhone?: string | null;
  note?: string | null;
  rejectionReason?: string | null;
  cancellationReason?: string | null;
  proposedSlots: ViewingSlotDTO[];
  selectedSlot?: ViewingSlotDTO | null;
  createdAt: string;
}

export interface PaginatedViewingAppointmentsDTO {
  items: ViewingAppointmentItemDTO[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ViewingAppointmentDetailDTO {
  appointmentId: string;
  roomId: string;
  tenantId: string;
  status: string;
  contactPhone?: string | null;
  note?: string | null;
  rejectionReason?: string | null;
  cancellationReason?: string | null;
  proposedSlots: ViewingSlotDTO[];
  selectedSlot?: ViewingSlotDTO | null;
  room?: {
    id: string;
    roomCode: string;
    property?: {
      id: string;
      name: string;
      address: string;
    };
  };
  tenant?: {
    id: string;
    fullName: string;
  };
  createdAt: string;
}

export interface CreateViewingAppointmentResponseDTO {
  appointmentId: string;
  status: string;
}

export interface ConfirmViewingAppointmentResponseDTO {
  appointmentId: string;
  status: 'CONFIRMED';
  selectedSlot: ViewingSlotDTO;
}

export interface RejectViewingAppointmentResponseDTO {
  appointmentId: string;
  status: 'REJECTED';
  rejectionReason: string;
}

export interface CancelViewingAppointmentResponseDTO {
  appointmentId: string;
  status: 'CANCELLED';
  cancellationReason: string;
}
