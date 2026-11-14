# [BE-P2-01] Quản lý khu trọ và xem chi tiết khu trọ công khai — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Xây dựng module `src/modules/properties/` cung cấp API quản lý khu trọ dành riêng cho Chủ trọ (`LANDLORD`) và API tra cứu chi tiết khu trọ công khai dành cho Khách tìm trọ, tuân thủ kiến trúc phân tầng `Route → Controller → Service → Repository → Prisma Client` và chính sách Public Visibility của Room Discovery Phase 1.

**Architecture:** Áp dụng mô hình Controller → Service → Repository. Controller tiếp nhận request, gọi middleware phân quyền `requireAuth` + `requireRole('LANDLORD')` và Zod validator; Service chịu trách nhiệm xử lý logic nghiệp vụ, kiểm tra quyền sở hữu khu trọ và áp dụng bộ lọc Public Visibility; Repository thực thi các câu lệnh Prisma Client singleton trên các bảng `Property`, `PropertyAmenity`, `Amenity`, `Room`. DTO trả về cho Chủ trọ và Khách vãng lai được tách biệt hoàn toàn qua mapper.

**Tech Stack:** Node.js 24, Express 5, TypeScript 5.8, Prisma 6.19.3 (PostgreSQL), Zod 4, OpenAPI 3.1, Node test runner (`node:test`, `node:assert/strict`).

**Spec:** `docs/issues/p2-01-property-management.md` và tài liệu mô tả task `[BE-P2-01]`.

---

## Global Constraints

- Tuân thủ nghiêm ngặt `AGENTS.md`: không tự ý cài đặt thêm dependency nếu chưa được phê duyệt; sử dụng Prisma Client singleton duy nhất tại `src/infrastructure/database/prisma.ts`.
- Không gọi Prisma trực tiếp trong Service hoặc Controller; mọi thao tác DB với Property phải qua `PropertyRepository`.
- Không có trường `Property.description` hay `Property.isArchived` trong Prisma Schema hiện tại; trạng thái khu trọ được quản lý hoàn toàn bằng cột `Property.status` (`ACTIVE`, `INACTIVE`, `ARCHIVED`).
- Lấy `landlordId` duy nhất từ danh tính đã xác thực (`res.locals.userId`), tuyệt đối không tin cậy `landlordId` gửi từ request body hay query.
- API công khai `GET /api/v1/properties/{propertyId}` không yêu cầu token, chỉ trả về dữ liệu khi: `Property.status === 'ACTIVE'` AND `User(landlord).accountStatus === 'ACTIVE'` AND tồn tại ít nhất 1 phòng thỏa mãn Room Discovery (`occupancyStatus === 'VACANT'` AND `visibilityStatus === 'VISIBLE'` AND `isArchived === false`). Nếu không thỏa, trả về `404 Not Found`.
- Tuyệt đối không để lộ thông tin nhạy cảm của Chủ trọ (mật khẩu, passwordHash, CCCD, thông tin ngân hàng, số điện thoại cá nhân không công khai) trong bất kỳ response nào.
- Error format chuẩn: `{ success: false, code: string, message: string, traceId: string, errors?: Record<string, string[]> }` dùng `ApiError`.

---

## Review Focus

1. **Khách truy cập khu trọ chưa có phòng mở bán:** Khu trọ `ACTIVE` nhưng toàn bộ phòng đang `HIDDEN` hoặc `MAINTENANCE` $\rightarrow$ API công khai phải trả về đúng `404 Not Found` với mã `PROPERTY_NOT_FOUND`, không để lộ thông tin khu trọ.
2. **Chủ trọ này thao tác trên khu trọ của Chủ trọ khác:** Chủ trọ B gửi request sửa/xem chi tiết quản lý khu trọ của Chủ trọ A $\rightarrow$ phải bị chặn với lỗi `403 FORBIDDEN` (hoặc `404` để che giấu tài nguyên).
3. **Tạo khu trọ với danh sách tiện ích không hợp lệ:** Request gửi kèm UUID tiện ích không tồn tại trong bảng `amenities` $\rightarrow$ phải rollback transaction và trả về `400 VALIDATION_ERROR` nêu rõ trường lỗi.
4. **Phân trang danh sách khu trọ của Chủ trọ:** Query `page` và `pageSize` với số âm, 0, chuỗi ký tự, hoặc số trang vượt quá tổng số bản ghi $\rightarrow$ phải chuẩn hóa an toàn (fallback về page=1, pageSize=10, max pageSize=50).
5. **Rò rỉ phòng ẩn trong chi tiết khu trọ công khai:** Khi một khu trọ đủ điều kiện hiển thị công khai, danh sách phòng đính kèm trong response công khai chỉ được chứa các phòng thỏa điều kiện Room Discovery, tuyệt đối không chứa phòng `HIDDEN`, `MAINTENANCE` hay `isArchived: true`.

---

## File Structure

```text
src/
├── common/
│   └── middleware/
│       ├── error-handler.ts          (Đã có)
│       └── require-role.ts            (Tạo mới: Middleware kiểm tra Role người dùng)
└── modules/
    └── properties/
        ├── property.types.ts          (Tạo mới: DTOs, Filter Interfaces)
        ├── property.validation.ts     (Tạo mới: Zod Schemas)
        ├── property.mapper.ts         (Tạo mới: DTO Mappers cho Landlord & Public)
        ├── property.repository.ts     (Tạo mới: Tầng truy xuất CSDL qua Prisma)
        ├── property.service.ts        (Tạo mới: Logic nghiệp vụ & Public Visibility Policy)
        ├── property.controller.ts     (Tạo mới: Controller xử lý HTTP Request)
        └── property.routes.ts         (Tạo mới: Định tuyến routes)
docs/
└── openapi/
    └── property-management.yaml       (Tạo mới: OpenAPI 3.1 Contract)
tests/
└── properties/
    ├── require-role.test.ts           (Tạo mới: Test middleware phân quyền)
    ├── property-validation.test.ts    (Tạo mới: Test Zod validation)
    ├── property-mapper.test.ts        (Tạo mới: Test chuyển đổi DTO)
    ├── property-service.test.ts       (Tạo mới: Test nghiệp vụ và visibility)
    └── property-api.test.ts           (Tạo mới: Test HTTP integration)
```

---

## Task Decomposition

### Task 1: OpenAPI 3.1 Specification Contract

**Files:**
- Create: `docs/openapi/property-management.yaml`

**Interfaces:**
- Consumes: None
- Produces: OpenAPI 3.1 document with endpoints:
  - `POST /api/v1/landlord/properties`
  - `GET /api/v1/landlord/properties`
  - `GET /api/v1/landlord/properties/{propertyId}`
  - `GET /api/v1/properties/{propertyId}`
  - `PUT /api/v1/landlord/properties/{propertyId}`
  - `PATCH /api/v1/landlord/properties/{propertyId}/archive`

- [ ] **Step 1: Write OpenAPI 3.1 schema defining requests, responses, DTOs, and error codes**
- [ ] **Step 2: Validate OpenAPI syntax using a YAML/OpenAPI linter or schema validator**
- [ ] **Step 3: Commit specification**
  ```bash
  git add docs/openapi/property-management.yaml
  git commit -m "docs(properties): define OpenAPI 3.1 property management contract"
  ```

---

### Task 2: Role Authorization Guard Middleware (`requireRole`)

**Files:**
- Create: `src/common/middleware/require-role.ts`
- Test: `tests/properties/require-role.test.ts`

**Interfaces:**
- Consumes: `res.locals.userId` set by `requireAuth` (`src/common/require-auth.ts`), `prisma` singleton.
- Produces: `requireRole(role: string): RequestHandler` middleware function that verifies user role and active status from DB.

- [ ] **Step 1: Write failing unit test for `requireRole` middleware**
  - Test missing `res.locals.userId` $\rightarrow$ throws `ApiError(401, 'UNAUTHORIZED')`.
  - Test user not found $\rightarrow$ throws `ApiError(401, 'UNAUTHORIZED')`.
  - Test user `accountStatus !== 'ACTIVE'` $\rightarrow$ throws `ApiError(403, 'ACCOUNT_LOCKED')`.
  - Test user with different role (e.g. `TENANT`) $\rightarrow$ throws `ApiError(403, 'FORBIDDEN', 'Yêu cầu quyền hạn phù hợp')`.
  - Test user with matching role (e.g. `LANDLORD`) $\rightarrow$ calls `next()`.
- [ ] **Step 2: Run test to verify it fails**
  Run: `npx tsx --test tests/properties/require-role.test.ts`
  Expected: FAIL (cannot find module `require-role`).
- [ ] **Step 3: Implement `requireRole` in `src/common/middleware/require-role.ts`**
  ```typescript
  import type { RequestHandler } from 'express';
  import { ApiError } from '../errors/api-error';
  import { prisma } from '../../infrastructure/database/prisma';

  export function requireRole(...allowedRoles: string[]): RequestHandler {
    return async (_req, res, next) => {
      try {
        const userId = res.locals.userId as string | undefined;
        if (!userId) throw new ApiError(401, 'UNAUTHORIZED', 'Cần đăng nhập để thực hiện');

        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, role: true, accountStatus: true },
        });

        if (!user) throw new ApiError(401, 'UNAUTHORIZED', 'Tài khoản không tồn tại');
        if (user.accountStatus !== 'ACTIVE') throw new ApiError(403, 'ACCOUNT_LOCKED', 'Tài khoản không thể truy cập');
        if (!allowedRoles.includes(user.role)) throw new ApiError(403, 'FORBIDDEN', 'Bạn không có quyền thực hiện thao tác này');

        res.locals.currentUser = user;
        next();
      } catch (error) {
        next(error);
      }
    };
  }
  ```
- [ ] **Step 4: Run test to verify it passes**
  Run: `npx tsx --test tests/properties/require-role.test.ts`
  Expected: PASS
- [ ] **Step 5: Commit**
  ```bash
  git add src/common/middleware/require-role.ts tests/properties/require-role.test.ts
  git commit -m "feat(auth): add requireRole middleware guard"
  ```

---

### Task 3: Property Types & Validation Schemas (`property.types.ts`, `property.validation.ts`)

**Files:**
- Create: `src/modules/properties/property.types.ts`
- Create: `src/modules/properties/property.validation.ts`
- Test: `tests/properties/property-validation.test.ts`

**Interfaces:**
- Consumes: `zod`, `src/common/errors/api-error.ts`.
- Produces: Type definitions and functions:
  - `validateCreateProperty(body: unknown): CreatePropertyInput`
  - `validateUpdateProperty(body: unknown): UpdatePropertyInput`
  - `validatePropertyListQuery(query: unknown): PropertyListQuery`
  - `validatePropertyId(id: unknown): string`

- [ ] **Step 1: Write failing unit tests for property validation**
  - Test valid create payload: `{ name: 'Nhà trọ Hòa Bình', address: '123 Đỗ Xuân Hợp, Q9', houseRules: 'Không ồn ào sau 23h', amenityIds: ['uuid-1', 'uuid-2'] }` $\rightarrow$ passes.
  - Test invalid payloads: empty name, name > 200 chars, empty address, invalid amenity UUID, non-boolean/non-string fields $\rightarrow$ throws `ApiError(400, 'VALIDATION_ERROR')` with field-level errors.
  - Test valid list query params: `page`, `pageSize`, `search`, `status`.
  - Test invalid property ID: non-UUID string $\rightarrow$ throws `ApiError(400, 'VALIDATION_ERROR')`.
- [ ] **Step 2: Run test to verify it fails**
  Run: `npx tsx --test tests/properties/property-validation.test.ts`
  Expected: FAIL (cannot find module).
- [ ] **Step 3: Define types in `property.types.ts` and implement schemas in `property.validation.ts`**
  - `property.types.ts`: Define `CreatePropertyInput`, `UpdatePropertyInput`, `PropertyListQuery`, `LandlordPropertyCardDTO`, `LandlordPropertyDetailDTO`, `PublicPropertyDetailDTO`, `PropertyStats`.
  - `property.validation.ts`: Implement schemas using Zod strict object validation and parse helper.
- [ ] **Step 4: Run test to verify it passes**
  Run: `npx tsx --test tests/properties/property-validation.test.ts`
  Expected: PASS
- [ ] **Step 5: Commit**
  ```bash
  git add src/modules/properties/property.types.ts src/modules/properties/property.validation.ts tests/properties/property-validation.test.ts
  git commit -m "feat(properties): add property types and Zod validation schemas"
  ```

---

### Task 4: Property Mappers (`property.mapper.ts`)

**Files:**
- Create: `src/modules/properties/property.mapper.ts`
- Test: `tests/properties/property-mapper.test.ts`

**Interfaces:**
- Consumes: Prisma model return types (`Property` with relations `amenities`, `rooms`, `landlord`).
- Produces:
  - `mapToLandlordPropertyCard(property, roomStats): LandlordPropertyCardDTO`
  - `mapToLandlordPropertyDetail(property, roomStats): LandlordPropertyDetailDTO`
  - `mapToPublicPropertyDetail(property, publicRooms): PublicPropertyDetailDTO`

- [ ] **Step 1: Write failing unit test for mappers**
  - Test `mapToLandlordPropertyCard`: formats counts (total rooms, vacant, occupied, maintenance), amenities, cover image.
  - Test `mapToLandlordPropertyDetail`: returns complete room list (including hidden/maintenance rooms) with their status.
  - Test `mapToPublicPropertyDetail`: returns ONLY public rooms, landlord public info (fullName), excludes private stats/admin notes.
- [ ] **Step 2: Run test to verify it fails**
  Run: `npx tsx --test tests/properties/property-mapper.test.ts`
  Expected: FAIL
- [ ] **Step 3: Implement mapper functions in `src/modules/properties/property.mapper.ts`**
- [ ] **Step 4: Run test to verify it passes**
  Run: `npx tsx --test tests/properties/property-mapper.test.ts`
  Expected: PASS
- [ ] **Step 5: Commit**
  ```bash
  git add src/modules/properties/property.mapper.ts tests/properties/property-mapper.test.ts
  git commit -m "feat(properties): add Landlord and Public Property DTO mappers"
  ```

---

### Task 5: Property Repository Layer (`property.repository.ts`)

**Files:**
- Create: `src/modules/properties/property.repository.ts`

**Interfaces:**
- Consumes: `prisma` singleton (`src/infrastructure/database/prisma.ts`), `property.types.ts`.
- Produces `PropertyRepository` class with static methods:
  - `createProperty(landlordId: string, data: CreatePropertyInput): Promise<PrismaPropertyWithRelations>`
  - `findLandlordProperties(landlordId: string, query: PropertyListQuery): Promise<{ items: any[]; totalItems: number }>`
  - `findPropertyById(propertyId: string): Promise<PrismaPropertyWithRelations | null>`
  - `updateProperty(propertyId: string, data: UpdatePropertyInput): Promise<PrismaPropertyWithRelations>`
  - `updatePropertyStatus(propertyId: string, status: string): Promise<PrismaPropertyWithRelations>`
  - `validateAmenityIds(amenityIds: string[]): Promise<boolean>`
  - `countRoomsByPropertyAndStatus(propertyId: string): Promise<Record<string, number>>`

- [ ] **Step 1: Write unit tests with Prisma stubs verifying repository queries**
  - Verify `createProperty` performs nested `propertyAmenities.create` within transaction.
  - Verify `findLandlordProperties` builds proper Prisma `where` clause with `landlordId`, optional keyword search on `name` or `address`, and status filter.
  - Verify `validateAmenityIds` returns false if count of found amenities < `amenityIds.length`.
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement `PropertyRepository` in `src/modules/properties/property.repository.ts`**
  - Ensure all database interactions utilize the Prisma singleton.
  - Ensure transactions (`prisma.$transaction`) are used when creating/updating properties with amenities.
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**
  ```bash
  git add src/modules/properties/property.repository.ts
  git commit -m "feat(properties): implement PropertyRepository data access layer"
  ```

---

### Task 6: Property Service Layer (`property.service.ts`)

**Files:**
- Create: `src/modules/properties/property.service.ts`
- Test: `tests/properties/property-service.test.ts`

**Interfaces:**
- Consumes: `PropertyRepository`, `PropertyMapper`, `property.types.ts`, `ApiError`.
- Produces `PropertyService` class with static methods:
  - `createProperty(landlordId: string, input: CreatePropertyInput): Promise<LandlordPropertyDetailDTO>`
  - `getLandlordProperties(landlordId: string, query: PropertyListQuery): Promise<PaginatedLandlordProperties>`
  - `getLandlordPropertyDetail(landlordId: string, propertyId: string): Promise<LandlordPropertyDetailDTO>`
  - `getPublicPropertyDetail(propertyId: string): Promise<PublicPropertyDetailDTO>`
  - `updateProperty(landlordId: string, propertyId: string, input: UpdatePropertyInput): Promise<LandlordPropertyDetailDTO>`
  - `archiveProperty(landlordId: string, propertyId: string): Promise<void>`

- [ ] **Step 1: Write unit tests covering business logic and visibility policy in `tests/properties/property-service.test.ts`**
  - Test ownership check: `getLandlordPropertyDetail` with `landlordId !== property.landlordId` $\rightarrow$ throws `ApiError(403, 'FORBIDDEN')`.
  - Test public detail visibility policy:
    - Property not active $\rightarrow$ throws `ApiError(404, 'PROPERTY_NOT_FOUND')`.
    - Landlord not active $\rightarrow$ throws `ApiError(404, 'PROPERTY_NOT_FOUND')`.
    - Property active & Landlord active, but 0 rooms are `VACANT + VISIBLE + !isArchived` $\rightarrow$ throws `ApiError(404, 'PROPERTY_NOT_FOUND')`.
    - Property active & Landlord active, and has 1+ public rooms $\rightarrow$ returns 200 OK with filtered public rooms.
  - Test amenity validation: unknown amenity ID $\rightarrow$ throws `ApiError(400, 'AMENITY_NOT_FOUND')`.
- [ ] **Step 2: Run test to verify it fails**
  Run: `npx tsx --test tests/properties/property-service.test.ts`
  Expected: FAIL
- [ ] **Step 3: Implement `PropertyService` in `src/modules/properties/property.service.ts`**
  - Implement ownership check helpers.
  - Implement Room Discovery visibility filters for public detail:
    `room.occupancyStatus === 'VACANT' && room.visibilityStatus === 'VISIBLE' && !room.isArchived`.
- [ ] **Step 4: Run test to verify it passes**
  Run: `npx tsx --test tests/properties/property-service.test.ts`
  Expected: PASS
- [ ] **Step 5: Commit**
  ```bash
  git add src/modules/properties/property.service.ts tests/properties/property-service.test.ts
  git commit -m "feat(properties): implement PropertyService business logic and visibility rules"
  ```

---

### Task 7: Property Controller, Routes & App Mounting

**Files:**
- Create: `src/modules/properties/property.controller.ts`
- Create: `src/modules/properties/property.routes.ts`
- Modify: `src/app.ts`
- Test: `tests/properties/property-api.test.ts`

**Interfaces:**
- Consumes: `PropertyService`, `PropertyValidation`, `requireAuth`, `requireRole`, `errorHandler`.
- Produces: Express routes mounted on `app`:
  - `POST /api/v1/landlord/properties`
  - `GET /api/v1/landlord/properties`
  - `GET /api/v1/landlord/properties/:propertyId`
  - `PUT /api/v1/landlord/properties/:propertyId`
  - `PATCH /api/v1/landlord/properties/:propertyId/archive`
  - `GET /api/v1/properties/:propertyId`

- [ ] **Step 1: Write HTTP endpoint integration tests in `tests/properties/property-api.test.ts`**
  - Test unauthorized requests $\rightarrow$ `401 UNAUTHORIZED`.
  - Test tenant calling landlord endpoint $\rightarrow$ `403 FORBIDDEN`.
  - Test landlord creating property $\rightarrow$ `201 CREATED`.
  - Test landlord reading own properties $\rightarrow$ `200 OK`.
  - Test public endpoint without auth for valid active property with vacant room $\rightarrow$ `200 OK`.
  - Test public endpoint for property with only hidden rooms $\rightarrow$ `404 NOT_FOUND`.
- [ ] **Step 2: Run test to verify it fails**
  Run: `npx tsx --test tests/properties/property-api.test.ts`
  Expected: FAIL
- [ ] **Step 3: Implement `PropertyController` and `property.routes.ts`**
  - Ensure controller methods are structured, parse validated data, call service, and forward errors via `try/catch` + `next(error)`.
  - Mount landlord routes with `requireAuth` + `requireRole('LANDLORD')`.
  - Mount public route without authentication.
- [ ] **Step 4: Mount `propertyRouter` in `src/app.ts`**
  ```typescript
  import { propertyRouter } from './modules/properties/property.routes';
  // ...
  app.use(propertyRouter);
  ```
- [ ] **Step 5: Run test to verify it passes**
  Run: `npx tsx --test tests/properties/property-api.test.ts`
  Expected: PASS
- [ ] **Step 6: Commit**
  ```bash
  git add src/modules/properties/property.controller.ts src/modules/properties/property.routes.ts src/app.ts tests/properties/property-api.test.ts
  git commit -m "feat(properties): connect PropertyController, routes and mount in app"
  ```

---

### Task 8: Verification & Quality Gate

**Files:**
- Test: All test suites in `tests/`
- Audit: OpenAPI spec validation, typecheck, build

- [ ] **Step 1: Run complete typecheck**
  Run: `npm run typecheck`
  Expected: 0 errors (`tsc --noEmit`)
- [ ] **Step 2: Run build**
  Run: `npm run build`
  Expected: Build succeeds into `dist/`
- [ ] **Step 3: Run entire test suite**
  Run: `npx tsx --test tests/**/*.test.ts tests/*.test.ts`
  Expected: All tests PASS
- [ ] **Step 4: Check git status and staged diff for clean working tree**
  Run: `git status --short`
  Expected: Clean, no untracked artifacts, no leaked credentials.
- [ ] **Step 5: Final review commit**
  ```bash
  git commit --allow-empty -m "chore(properties): complete BE-P2-01 property management verification"
  ```
