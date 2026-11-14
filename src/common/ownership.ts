import { ApiError } from './errors/api-error';
import { prisma } from '../infrastructure/database/prisma';

export const OWNERSHIP_ERRORS = {
  PROPERTY: {
    code: 'PROPERTY_NOT_FOUND',
    message: 'Khu trọ không tồn tại hoặc bạn không có quyền truy cập',
  },
  ROOM: {
    code: 'ROOM_NOT_FOUND',
    message: 'Phòng trọ không tồn tại hoặc bạn không có quyền truy cập',
  },
  APPOINTMENT: {
    code: 'APPOINTMENT_NOT_FOUND',
    message: 'Lịch hẹn không tồn tại hoặc bạn không có quyền truy cập',
  },
  RENTAL_REQUEST: {
    code: 'RENTAL_REQUEST_NOT_FOUND',
    message: 'Yêu cầu thuê không tồn tại hoặc bạn không có quyền truy cập',
  },
} as const;

/**
 * Assertion helpers for Service / Repository layers
 */
export function assertPropertyFound<T>(item: T | null | undefined): asserts item is T {
  if (!item) {
    throw new ApiError(404, OWNERSHIP_ERRORS.PROPERTY.code, OWNERSHIP_ERRORS.PROPERTY.message);
  }
}

export function assertRoomFound<T>(item: T | null | undefined): asserts item is T {
  if (!item) {
    throw new ApiError(404, OWNERSHIP_ERRORS.ROOM.code, OWNERSHIP_ERRORS.ROOM.message);
  }
}

export function assertAppointmentFound<T>(item: T | null | undefined): asserts item is T {
  if (!item) {
    throw new ApiError(404, OWNERSHIP_ERRORS.APPOINTMENT.code, OWNERSHIP_ERRORS.APPOINTMENT.message);
  }
}

export function assertRentalRequestFound<T>(item: T | null | undefined): asserts item is T {
  if (!item) {
    throw new ApiError(404, OWNERSHIP_ERRORS.RENTAL_REQUEST.code, OWNERSHIP_ERRORS.RENTAL_REQUEST.message);
  }
}

/**
 * Scoped query helper: check that a landlord owns a property
 */
export async function assertLandlordProperty(propertyId: string, landlordId: string) {
  const property = await prisma.property.findFirst({
    where: {
      id: propertyId,
      landlordId,
    },
  });
  assertPropertyFound(property);
  return property;
}

/**
 * Scoped query helper: check that a landlord owns a room (via room.property.landlordId)
 */
export async function assertLandlordRoom(roomId: string, landlordId: string) {
  const room = await prisma.room.findFirst({
    where: {
      id: roomId,
      property: {
        landlordId,
      },
    },
  });
  assertRoomFound(room);
  return room;
}

/**
 * Scoped query helper: check viewing appointment access (#18)
 * - Tenant can only access their own appointments (tenantId)
 * - Landlord can only access appointments for rooms in their properties (room.property.landlordId)
 * - Admin does NOT automatically bypass ownership
 */
export async function assertScopedAppointment(
  appointmentId: string,
  user: { id: string; role: string },
) {
  const where = user.role === 'LANDLORD'
    ? { id: appointmentId, room: { property: { landlordId: user.id } } }
    : { id: appointmentId, tenantId: user.id };

  const appointment = await prisma.viewingAppointment.findFirst({
    where,
  });
  assertAppointmentFound(appointment);
  return appointment;
}

/**
 * Scoped query helper: check rental request access (#19)
 * - Tenant can only access their own rental requests (tenantId)
 * - Landlord can only access requests for rooms in their properties (room.property.landlordId)
 * - Admin does NOT automatically bypass ownership
 */
export async function assertScopedRentalRequest(
  requestId: string,
  user: { id: string; role: string },
) {
  const where = user.role === 'LANDLORD'
    ? { id: requestId, room: { property: { landlordId: user.id } } }
    : { id: requestId, tenantId: user.id };

  const request = await prisma.rentalRequest.findFirst({
    where,
  });
  assertRentalRequestFound(request);
  return request;
}
