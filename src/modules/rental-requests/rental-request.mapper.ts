import type {
  RentalRequestStatus,
  RentalRequestCreatedResponse,
  RentalRequestSummaryDTO,
  RentalRequestDetailDTO,
} from './rental-request.types';

function formatDateOnly(date: Date): string {
  return date.toISOString().split('T')[0];
}

interface RawRentalRequestBase {
  id: string;
  roomId: string;
  tenantId: string;
  desiredStartDate: Date;
  durationMonths: number | null;
  message: string | null;
  status: string;
  rejectionReason: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

export function mapToRentalRequestCreated(raw: RawRentalRequestBase): RentalRequestCreatedResponse {
  return {
    rentalRequestId: raw.id,
    status: 'PENDING',
    desiredMoveInDate: formatDateOnly(raw.desiredStartDate),
    durationMonths: raw.durationMonths,
    message: raw.message,
    createdAt: raw.createdAt.toISOString(),
  };
}

export interface RawRentalRequestSummary extends RawRentalRequestBase {
  room: {
    id: string;
    roomCode: string;
    property: {
      id: string;
      name: string;
    };
  };
  tenant: {
    id: string;
    fullName: string;
  };
}

export function mapToRentalRequestSummary(raw: RawRentalRequestSummary): RentalRequestSummaryDTO {
  return {
    id: raw.id,
    rentalRequestId: raw.id,
    roomId: raw.roomId,
    status: raw.status as RentalRequestStatus,
    desiredMoveInDate: formatDateOnly(raw.desiredStartDate),
    durationMonths: raw.durationMonths,
    message: raw.message,
    rejectionReason: raw.rejectionReason,
    reviewedAt: raw.reviewedAt ? raw.reviewedAt.toISOString() : null,
    createdAt: raw.createdAt.toISOString(),
    room: {
      id: raw.room.id,
      roomCode: raw.room.roomCode,
      property: {
        id: raw.room.property.id,
        name: raw.room.property.name,
      },
    },
    tenant: {
      id: raw.tenant.id,
      fullName: raw.tenant.fullName,
    },
  };
}

export interface RawRentalRequestDetail extends RawRentalRequestBase {
  room: {
    id: string;
    roomCode: string;
    monthlyRent: { toNumber(): number } | number;
    property: {
      id: string;
      name: string;
      address: string;
    };
  };
  tenant: {
    id: string;
    fullName: string;
  };
}

export function mapToRentalRequestDetail(raw: RawRentalRequestDetail): RentalRequestDetailDTO {
  const rentNumber =
    typeof raw.room.monthlyRent === 'number'
      ? raw.room.monthlyRent
      : typeof raw.room.monthlyRent.toNumber === 'function'
      ? raw.room.monthlyRent.toNumber()
      : Number(raw.room.monthlyRent);

  return {
    id: raw.id,
    rentalRequestId: raw.id,
    roomId: raw.roomId,
    tenantId: raw.tenantId,
    status: raw.status as RentalRequestStatus,
    desiredMoveInDate: formatDateOnly(raw.desiredStartDate),
    durationMonths: raw.durationMonths,
    message: raw.message,
    rejectionReason: raw.rejectionReason,
    reviewedAt: raw.reviewedAt ? raw.reviewedAt.toISOString() : null,
    createdAt: raw.createdAt.toISOString(),
    room: {
      id: raw.room.id,
      roomCode: raw.room.roomCode,
      monthlyRent: rentNumber,
      property: {
        id: raw.room.property.id,
        name: raw.room.property.name,
        address: raw.room.property.address,
      },
    },
    tenant: {
      id: raw.tenant.id,
      fullName: raw.tenant.fullName,
    },
  };
}
