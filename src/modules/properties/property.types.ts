export interface AmenityDTO {
  id: string;
  name: string;
  scope: string;
}

export interface LandlordPropertyStatsDTO {
  totalRooms: number;
  vacantRooms: number;
  occupiedRooms: number;
  maintenanceRooms: number;
}

export interface LandlordRoomItemDTO {
  id: string;
  roomCode: string;
  floor: number | null;
  areaM2: number;
  maxOccupants: number;
  monthlyRent: number;
  depositRequired: number;
  occupancyStatus: string;
  visibilityStatus: string;
  isArchived: boolean;
}

export interface LandlordPropertyCardDTO {
  id: string;
  name: string;
  address: string;
  houseRules: string | null;
  coverImageUrl: string | null;
  status: string;
  stats: LandlordPropertyStatsDTO;
  amenities: AmenityDTO[];
  createdAt: Date;
}

export interface LandlordPropertyDetailDTO extends LandlordPropertyCardDTO {
  rooms: LandlordRoomItemDTO[];
  updatedAt: Date;
}

export interface PublicLandlordProfileDTO {
  id: string;
  fullName: string;
}

export interface PublicRoomSummaryDTO {
  id: string;
  roomCode: string;
  floor: number | null;
  areaM2: number;
  maxOccupants: number;
  monthlyRent: number;
  depositRequired: number;
  coverImageUrl: string | null;
}

export interface PublicPropertyDetailDTO {
  id: string;
  name: string;
  address: string;
  houseRules: string | null;
  coverImageUrl: string | null;
  landlord: PublicLandlordProfileDTO;
  amenities: AmenityDTO[];
  rooms: PublicRoomSummaryDTO[];
  totalVacantRooms: number;
}

export interface CreatePropertyInput {
  name: string;
  address: string;
  houseRules: string | null;
  coverImageUrl: string | null;
  amenityIds: string[];
}

export interface UpdatePropertyInput {
  name: string;
  address: string;
  houseRules: string | null;
  coverImageUrl: string | null;
  amenityIds: string[];
}

export interface PropertyListQuery {
  page: number;
  pageSize: number;
  search?: string;
  status?: string;
}

export interface PaginatedLandlordProperties {
  items: LandlordPropertyCardDTO[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}
