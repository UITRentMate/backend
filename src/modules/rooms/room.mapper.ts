import { type Decimal } from '@prisma/client/runtime/library';
import {
  type RoomCardDTO,
  type PublicRoomDetailDTO,
  type AmenityItemDTO,
  type RoomServiceFeeDTO,
} from './room.types';
import {
  type PrismaRoomCardRecord,
  type PrismaRoomDetailRecord,
} from './room.repository';

export type { PrismaRoomCardRecord, PrismaRoomDetailRecord };

/**
 * Chuyển Decimal (hoặc number) sang JavaScript number an toàn.
 */
function toNumber(val: Decimal | number): number {
  if (typeof val === 'number') return val;
  return typeof val.toNumber === 'function' ? val.toNumber() : Number(val);
}

/**
 * Ánh xạ dữ liệu Prisma Room sang RoomCardDTO cho SEARCH-01.
 */
export function mapToRoomCardDTO(room: PrismaRoomCardRecord): RoomCardDTO {
  // Lấy danh sách tiện ích phòng trước, sắp xếp ổn định
  const roomAmenityNames = room.roomAmenities
    .map((ra) => ra.amenity.name)
    .sort((a, b) => a.localeCompare(b, 'vi'));

  // Lấy danh sách tiện ích tòa nhà sau, sắp xếp ổn định
  const propAmenityNames = room.property.propertyAmenities
    .map((pa) => pa.amenity.name)
    .sort((a, b) => a.localeCompare(b, 'vi'));

  // Hợp nhất và loại bỏ trùng lặp (ưu tiên phòng trước, khu trọ sau)
  const combinedAmenitiesSet = new Set<string>();
  for (const name of roomAmenityNames) {
    combinedAmenitiesSet.add(name);
  }
  for (const name of propAmenityNames) {
    combinedAmenitiesSet.add(name);
  }

  // Lấy tối đa 4 tiện ích tiêu biểu gắn trên thẻ phòng
  const topAmenities = Array.from(combinedAmenitiesSet).slice(0, 4);

  return {
    roomId: room.id,
    roomCode: room.roomCode,
    title: `${room.property.name} - Phòng ${room.roomCode}`,
    monthlyRent: toNumber(room.monthlyRent),
    areaM2: toNumber(room.areaM2),
    maxOccupants: room.maxOccupants,
    occupancyStatus: 'VACANT',
    coverImageUrl: room.images[0]?.imageUrl ?? null,
    address: room.property.address,
    propertyId: room.property.id,
    propertyName: room.property.name,
    amenities: topAmenities,
  };
}

/**
 * Ánh xạ dữ liệu Prisma Room sang PublicRoomDetailDTO cho SEARCH-02.
 */
export function mapToPublicRoomDetailDTO(
  room: PrismaRoomDetailRecord,
  totalRooms: number,
  vacantRooms: number
): PublicRoomDetailDTO {
  const roomAmenities: AmenityItemDTO[] = room.roomAmenities
    .map((ra) => ({
      id: ra.amenity.id,
      name: ra.amenity.name,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'));

  const propertyAmenities: AmenityItemDTO[] = room.property.propertyAmenities
    .map((pa) => ({
      id: pa.amenity.id,
      name: pa.amenity.name,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'));

  const serviceFees: RoomServiceFeeDTO[] = room.serviceFees.map((fee) => ({
    id: fee.id,
    feeName: fee.feeName,
    monthlyAmount: toNumber(fee.monthlyAmount),
    isRequired: fee.isRequired,
  }));

  const isVerified =
    Array.isArray(room.property.landlord.landlordApplicationsAsApplicant) &&
    room.property.landlord.landlordApplicationsAsApplicant.length > 0;

  return {
    roomId: room.id,
    roomCode: room.roomCode,
    title: `${room.property.name} - Phòng ${room.roomCode}`,
    description: null, // Prisma Room hiện chưa có cột description, Phase 1 trả null theo Contract
    areaM2: toNumber(room.areaM2),
    maxOccupants: room.maxOccupants,
    floor: room.floor,
    occupancyStatus: 'VACANT',
    createdAt: room.createdAt.toISOString(),
    pricing: {
      monthlyRent: toNumber(room.monthlyRent),
      depositRequired: toNumber(room.depositRequired),
      electricityRate: toNumber(room.electricityRate),
      waterRate: toNumber(room.waterRate),
    },
    images: room.images.map((img) => ({
      id: img.id,
      imageUrl: img.imageUrl,
      sortOrder: img.sortOrder,
    })),
    amenities: {
      roomAmenities,
      propertyAmenities,
    },
    serviceFees,
    property: {
      id: room.property.id,
      name: room.property.name,
      address: room.property.address,
      houseRules: room.property.houseRules,
      coverImageUrl: room.property.coverImageUrl,
      summary: {
        totalRooms,
        vacantRooms,
      },
    },
    landlord: {
      id: room.property.landlord.id,
      fullName: room.property.landlord.fullName,
      isVerified,
    },
  };
}
