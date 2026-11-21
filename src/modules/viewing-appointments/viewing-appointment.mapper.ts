import type {
  ViewingSlotDTO,
  ViewingAppointmentItemDTO,
  ViewingAppointmentDetailDTO,
} from './viewing-appointment.types';

export function mapToViewingSlotDTO(slot: {
  id: string;
  startAt: Date | string;
}): ViewingSlotDTO {
  return {
    id: slot.id,
    startAt: slot.startAt instanceof Date ? slot.startAt.toISOString() : new Date(slot.startAt).toISOString(),
  };
}

export function mapToViewingAppointmentItemDTO(raw: {
  id: string;
  roomId: string;
  status: string;
  contactPhone?: string | null;
  note?: string | null;
  rejectionReason?: string | null;
  cancellationReason?: string | null;
  createdAt: Date | string;
  timeOptions?: Array<{ id: string; startAt: Date | string }>;
  selectedSlot?: { id: string; startAt: Date | string } | null;
}): ViewingAppointmentItemDTO {
  const proposedSlots = (raw.timeOptions ?? [])
    .map(mapToViewingSlotDTO)
    .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());

  return {
    appointmentId: raw.id,
    roomId: raw.roomId,
    status: raw.status,
    contactPhone: raw.contactPhone ?? null,
    note: raw.note ?? null,
    rejectionReason: raw.rejectionReason ?? null,
    cancellationReason: raw.cancellationReason ?? null,
    proposedSlots,
    selectedSlot: raw.selectedSlot ? mapToViewingSlotDTO(raw.selectedSlot) : null,
    createdAt: raw.createdAt instanceof Date ? raw.createdAt.toISOString() : new Date(raw.createdAt).toISOString(),
  };
}

export function mapToViewingAppointmentDetailDTO(raw: {
  id: string;
  roomId: string;
  tenantId: string;
  status: string;
  contactPhone?: string | null;
  note?: string | null;
  rejectionReason?: string | null;
  cancellationReason?: string | null;
  createdAt: Date | string;
  timeOptions?: Array<{ id: string; startAt: Date | string }>;
  selectedSlot?: { id: string; startAt: Date | string } | null;
  room?: {
    id: string;
    roomCode: string;
    property?: {
      id: string;
      name: string;
      address: string;
    } | null;
  } | null;
  tenant?: {
    id: string;
    fullName: string;
  } | null;
}): ViewingAppointmentDetailDTO {
  const item = mapToViewingAppointmentItemDTO(raw);

  return {
    ...item,
    tenantId: raw.tenantId,
    room: raw.room
      ? {
          id: raw.room.id,
          roomCode: raw.room.roomCode,
          property: raw.room.property
            ? {
                id: raw.room.property.id,
                name: raw.room.property.name,
                address: raw.room.property.address,
              }
            : undefined,
        }
      : undefined,
    tenant: raw.tenant
      ? {
          id: raw.tenant.id,
          fullName: raw.tenant.fullName,
        }
      : undefined,
  };
}
