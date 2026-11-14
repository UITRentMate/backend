import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma } from '../../src/infrastructure/database/prisma';
import { PropertyService } from '../../src/modules/properties/property.service';
import { ApiError } from '../../src/common/errors/api-error';

test('Live DB: full property lifecycle and ownership isolation', async (t) => {
  // Check if DB is reachable
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    t.skip('PostgreSQL is not available, skipping live DB test');
    return;
  }

  const landlord1Email = `landlord.integration.${Date.now()}.1@rentmate.vn`;
  const landlord2Email = `landlord.integration.${Date.now()}.2@rentmate.vn`;

  let landlord1: any;
  let landlord2: any;
  let createdPropertyId: string | null = null;

  try {
    // 1. Setup real landlords in database
    landlord1 = await prisma.user.create({
      data: {
        fullName: 'Chủ Trọ Test DB 1',
        email: landlord1Email,
        phone: `09${Math.floor(10000000 + Math.random() * 90000000)}`,
        passwordHash: 'dummyhash-for-testing',
        role: 'LANDLORD',
        accountStatus: 'ACTIVE',
      },
    });

    landlord2 = await prisma.user.create({
      data: {
        fullName: 'Chủ Trọ Test DB 2',
        email: landlord2Email,
        phone: `09${Math.floor(10000000 + Math.random() * 90000000)}`,
        passwordHash: 'dummyhash-for-testing',
        role: 'LANDLORD',
        accountStatus: 'ACTIVE',
      },
    });

    // Find a test amenity with PROPERTY scope if exists
    const testAmenity = await prisma.amenity.findFirst({
      where: { scope: { not: 'ROOM' } },
    });

    // 2. Test createProperty against real database
    const created = await PropertyService.createProperty(landlord1.id, {
      name: 'Khu Trọ Tích Hợp Real DB',
      address: '999 Đường Test, Quận Thủ Đức, TP.HCM',
      houseRules: 'Nội quy test DB',
      coverImageUrl: null,
      amenityIds: testAmenity ? [testAmenity.id] : [],
    });

    createdPropertyId = created.id;
    assert.ok(createdPropertyId);
    assert.equal(created.name, 'Khu Trọ Tích Hợp Real DB');
    assert.equal(created.status, 'ACTIVE');
    assert.equal(created.stats.totalRooms, 0);

    // 3. Test getLandlordProperties (list)
    const list = await PropertyService.getLandlordProperties(landlord1.id, {
      page: 1,
      pageSize: 10,
    });
    assert.ok(list.totalItems >= 1);
    assert.ok(list.items.some((p) => p.id === createdPropertyId));

    // 4. Test getLandlordPropertyDetail (owner detail)
    const detail = await PropertyService.getLandlordPropertyDetail(landlord1.id, createdPropertyId);
    assert.equal(detail.id, createdPropertyId);
    assert.equal(detail.name, 'Khu Trọ Tích Hợp Real DB');

    // 5. Test Anti-Enumeration: Landlord 2 accesses Landlord 1 property -> throws 404
    await assert.rejects(
      () => PropertyService.getLandlordPropertyDetail(landlord2.id, createdPropertyId!),
      (err: any) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.statusCode, 404);
        assert.equal(err.code, 'PROPERTY_NOT_FOUND');
        return true;
      },
    );

    // 6. Test updateProperty against real database
    const updated = await PropertyService.updateProperty(landlord1.id, createdPropertyId, {
      name: 'Khu Trọ Tích Hợp Đã Đổi Tên',
      address: '999 Đường Test Mới, Quận Thủ Đức, TP.HCM',
      houseRules: 'Nội quy mới',
      coverImageUrl: null,
      amenityIds: [],
    });
    assert.equal(updated.name, 'Khu Trọ Tích Hợp Đã Đổi Tên');

    // 7. Test archiveProperty against real database
    await PropertyService.archiveProperty(landlord1.id, createdPropertyId);
    const archivedDetail = await PropertyService.getLandlordPropertyDetail(landlord1.id, createdPropertyId);
    assert.equal(archivedDetail.status, 'ARCHIVED');
  } finally {
    // Cleanup created test records
    if (createdPropertyId) {
      await prisma.propertyAmenity.deleteMany({ where: { propertyId: createdPropertyId } }).catch(() => {});
      await prisma.room.deleteMany({ where: { propertyId: createdPropertyId } }).catch(() => {});
      await prisma.property.delete({ where: { id: createdPropertyId } }).catch(() => {});
    }
    if (landlord1?.id) {
      await prisma.user.delete({ where: { id: landlord1.id } }).catch(() => {});
    }
    if (landlord2?.id) {
      await prisma.user.delete({ where: { id: landlord2.id } }).catch(() => {});
    }
  }
});
