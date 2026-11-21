/**
 * Data Types & DTOs cho phân hệ Quản lý phòng trọ của Chủ trọ (BE-P2-02 / Issue #15)
 * Khớp 100% đặc tả OpenAPI 3.1 tại docs/openapi/room-management.yaml
 */

export interface CreateServiceFeeInput {
  feeName: string;
  monthlyAmount: number;
  isRequired?: boolean;
}

export interface CreateRoomInput {
  roomCode: string;
  floor?: number | null;
  areaM2: number;
  maxOccupants: number;
  monthlyRent: number;
  depositRequired: number;
  electricityRate: number;
  waterRate: number;
  amenityIds?: string[];
  serviceFees?: CreateServiceFeeInput[];
}

export interface UpdateRoomInput {
  roomCode: string;
  floor?: number | null;
  areaM2: number;
  maxOccupants: number;
  monthlyRent: number;
  depositRequired: number;
  electricityRate: number;
  waterRate: number;
  amenityIds?: string[];
  serviceFees?: CreateServiceFeeInput[];
}

export type AllowedOperationalStatus = 'VACANT' | 'MAINTENANCE';

export interface UpdateOperationalStatusInput {
  occupancyStatus: AllowedOperationalStatus;
}

export type AllowedVisibilityStatus = 'VISIBLE' | 'HIDDEN';

export interface UpdateVisibilityInput {
  visibilityStatus: AllowedVisibilityStatus;
}

export interface LandlordRoomListQuery {
  page: number;
  pageSize: number;
  search?: string;
  occupancyStatus?: string;
  visibilityStatus?: string;
}

export interface RoomStatusSummary {
  total: number;
  vacant: number;
  maintenance: number;
  rented: number;
  held: number;
  visible: number;
  hidden: number;
}

export interface LandlordAmenityDTO {
  id: string;
  name: string;
  scope: string;
}

export interface LandlordRoomServiceFeeDTO {
  id: string;
  feeName: string;
  monthlyAmount: number;
  isRequired: boolean;
}

export interface LandlordRoomImageDTO {
  id: string;
  imageUrl: string;
  sortOrder: number;
  createdAt: string;
}

export interface LandlordRoomItemDTO {
  id: string;
  propertyId: string;
  roomCode: string;
  floor: number | null;
  areaM2: number;
  maxOccupants: number;
  monthlyRent: number;
  depositRequired: number;
  electricityRate: number;
  waterRate: number;
  occupancyStatus: string;
  visibilityStatus: string;
  isArchived: boolean;
  coverImageUrl: string | null;
  totalImages: number;
  createdAt: string;
}

export interface LandlordRoomDetailResponse {
  id: string;
  propertyId: string;
  roomCode: string;
  floor: number | null;
  areaM2: number;
  maxOccupants: number;
  monthlyRent: number;
  depositRequired: number;
  electricityRate: number;
  waterRate: number;
  occupancyStatus: string;
  visibilityStatus: string;
  isArchived: boolean;
  amenities: LandlordAmenityDTO[];
  serviceFees: LandlordRoomServiceFeeDTO[];
  images: LandlordRoomImageDTO[];
  createdAt: string;
}

export interface PaginatedLandlordRoomsResponse {
  items: LandlordRoomItemDTO[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  summary: RoomStatusSummary;
}
