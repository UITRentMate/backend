// ============================================================================
// DTOs & Interfaces cho phân hệ Room Discovery (SEARCH-01 & SEARCH-02)
// Khớp 100% đặc tả OpenAPI 3.1 tại docs/openapi/room-discovery.yaml
// ============================================================================

export type SortByOption = 'newest' | 'price_asc' | 'price_desc' | 'area_asc' | 'area_desc';

export interface SearchRoomsQuery {
  keyword?: string;
  province?: string;
  district?: string;
  minPrice?: number;
  maxPrice?: number;
  minArea?: number;
  maxArea?: number;
  capacity?: number;
  amenities?: string[];
  sortBy: SortByOption;
  page: number;
  pageSize: number;
}

export interface RoomCardDTO {
  roomId: string;
  roomCode: string;
  title: string;
  monthlyRent: number;
  areaM2: number;
  maxOccupants: number;
  occupancyStatus: 'VACANT';
  coverImageUrl: string | null;
  address: string;
  propertyId: string;
  propertyName: string;
  amenities: string[];
}

export interface PaginatedRoomResponse {
  items: RoomCardDTO[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface RoomPricingDTO {
  monthlyRent: number;
  depositRequired: number;
  electricityRate: number;
  waterRate: number;
}

export interface RoomImageDTO {
  id: string;
  imageUrl: string;
  sortOrder: number;
}

export interface AmenityItemDTO {
  id: string;
  name: string;
}

export interface RoomServiceFeeDTO {
  id: string;
  feeName: string;
  monthlyAmount: number;
  isRequired: boolean;
}

export interface PropertySummaryDTO {
  totalRooms: number;
  vacantRooms: number;
}

export interface PropertyInDetailDTO {
  id: string;
  name: string;
  address: string;
  houseRules: string | null;
  coverImageUrl: string | null;
  summary: PropertySummaryDTO;
}

export interface LandlordPublicDTO {
  id: string;
  fullName: string;
  isVerified: boolean;
}

export interface PublicRoomDetailDTO {
  roomId: string;
  roomCode: string;
  title: string;
  description: string | null;
  areaM2: number;
  maxOccupants: number;
  floor: number | null;
  occupancyStatus: 'VACANT';
  createdAt: string;
  pricing: RoomPricingDTO;
  images: RoomImageDTO[];
  amenities: {
    roomAmenities: AmenityItemDTO[];
    propertyAmenities: AmenityItemDTO[];
  };
  serviceFees: RoomServiceFeeDTO[];
  property: PropertyInDetailDTO;
  landlord: LandlordPublicDTO;
}
