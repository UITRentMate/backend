// ============================================================================
// DTOs & Interfaces cho phân hệ Quản lý yêu cầu thuê phòng (Issue #19)
// ============================================================================

export type RentalRequestStatus = 'PENDING' | 'REJECTED';

export interface CreateRentalRequestInput {
  roomId: string;
  desiredMoveInDate: string;
  durationMonths?: number | null;
  message?: string | null;
}

export interface RejectRentalRequestInput {
  reason: string;
}

export interface RentalRequestFilterQuery {
  status?: RentalRequestStatus;
  roomId?: string;
  page: number;
  pageSize: number;
}

export interface RentalRequestCreatedResponse {
  rentalRequestId: string;
  status: 'PENDING';
  desiredMoveInDate: string;
  durationMonths: number | null;
  message: string | null;
  createdAt: string;
}

export interface RoomSummaryInRentalRequest {
  id: string;
  roomCode: string;
  property: {
    id: string;
    name: string;
  };
}

export interface TenantSummaryInRentalRequest {
  id: string;
  fullName: string;
}

export interface RentalRequestSummaryDTO {
  id: string;
  rentalRequestId: string;
  roomId: string;
  status: RentalRequestStatus;
  desiredMoveInDate: string;
  durationMonths: number | null;
  message: string | null;
  rejectionReason: string | null;
  reviewedAt: string | null;
  createdAt: string;
  room: RoomSummaryInRentalRequest;
  tenant: TenantSummaryInRentalRequest;
}

export interface RoomDetailInRentalRequest {
  id: string;
  roomCode: string;
  monthlyRent: number;
  property: {
    id: string;
    name: string;
    address: string;
  };
}

export interface RentalRequestDetailDTO {
  id: string;
  rentalRequestId: string;
  roomId: string;
  tenantId: string;
  status: RentalRequestStatus;
  desiredMoveInDate: string;
  durationMonths: number | null;
  message: string | null;
  rejectionReason: string | null;
  reviewedAt: string | null;
  createdAt: string;
  room: RoomDetailInRentalRequest;
  tenant: TenantSummaryInRentalRequest;
}

export interface PaginatedRentalRequestsResponse {
  items: RentalRequestSummaryDTO[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface RejectRentalRequestResponse {
  rentalRequestId: string;
  status: 'REJECTED';
  rejectionReason: string;
  reviewedAt: string;
}
