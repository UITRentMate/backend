import type {
  LandlordPropertyCardDTO,
  LandlordPropertyDetailDTO,
  LandlordPropertyStatsDTO,
  LandlordRoomItemDTO,
  PublicPropertyDetailDTO,
  PublicRoomSummaryDTO,
  AmenityDTO,
} from './property.types';

export function mapAmenities(propertyAmenities?: Array<{ amenity: { id: string; name: string; scope: string } }>): AmenityDTO[] {
  if (!propertyAmenities || !Array.isArray(propertyAmenities)) return [];
  return propertyAmenities.map((pa) => ({
    id: pa.amenity.id,
    name: pa.amenity.name,
    scope: pa.amenity.scope,
  }));
}

export function mapToLandlordPropertyCard(
  property: any,
  stats: LandlordPropertyStatsDTO,
): LandlordPropertyCardDTO {
  return {
    id: property.id,
    name: property.name,
    address: property.address,
    houseRules: property.houseRules ?? null,
    coverImageUrl: property.coverImageUrl ?? null,
    status: property.status,
    stats,
    amenities: mapAmenities(property.propertyAmenities),
    createdAt: property.createdAt,
  };
}

export function mapToLandlordPropertyDetail(
  property: any,
  stats: LandlordPropertyStatsDTO,
): LandlordPropertyDetailDTO {
  const rooms: LandlordRoomItemDTO[] = (property.rooms ?? []).map((room: any) => ({
    id: room.id,
    roomCode: room.roomCode,
    floor: room.floor ?? null,
    areaM2: Number(room.areaM2),
    maxOccupants: room.maxOccupants,
    monthlyRent: Number(room.monthlyRent),
    depositRequired: Number(room.depositRequired),
    occupancyStatus: room.occupancyStatus,
    visibilityStatus: room.visibilityStatus,
    isArchived: room.isArchived,
  }));

  return {
    ...mapToLandlordPropertyCard(property, stats),
    rooms,
  };
}

export function mapToPublicPropertyDetail(
  property: any,
  publicRooms: any[],
  totalVacantRooms: number,
): PublicPropertyDetailDTO {
  const rooms: PublicRoomSummaryDTO[] = publicRooms.map((room: any) => {
    const firstImage = room.images && room.images.length > 0 ? room.images[0].imageUrl : null;
    return {
      id: room.id,
      roomCode: room.roomCode,
      floor: room.floor ?? null,
      areaM2: Number(room.areaM2),
      maxOccupants: room.maxOccupants,
      monthlyRent: Number(room.monthlyRent),
      depositRequired: Number(room.depositRequired),
      coverImageUrl: firstImage,
    };
  });

  return {
    id: property.id,
    name: property.name,
    address: property.address,
    houseRules: property.houseRules ?? null,
    coverImageUrl: property.coverImageUrl ?? null,
    landlord: {
      id: property.landlord.id,
      fullName: property.landlord.fullName,
    },
    amenities: mapAmenities(property.propertyAmenities),
    rooms,
    totalVacantRooms,
  };
}
