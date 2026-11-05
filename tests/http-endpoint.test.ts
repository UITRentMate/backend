import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { type AddressInfo } from 'node:net';
import { app } from '../src/app';

let server: http.Server;
let baseUrl: string;

describe('HTTP Endpoints Integration Tests', () => {
  before(async () => {
    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  test('GET /health trả về 200 OK', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'rentmate-backend');
  });

  test('SEARCH-01: GET /api/v1/rooms/search mặc định trả về 200 Direct Payload', async () => {
    const res = await fetch(`${baseUrl}/api/v1/rooms/search`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;

    assert(Array.isArray(body.items));
    assert.equal(body.page, 1);
    assert.equal(body.pageSize, 12);
    assert.equal(typeof body.totalItems, 'number');
    assert.equal(typeof body.totalPages, 'number');
  });

  test('SEARCH-01: GET /api/v1/rooms/search?page=0 trả về 400 VALIDATION_ERROR', async () => {
    const res = await fetch(`${baseUrl}/api/v1/rooms/search?page=0`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;

    assert.equal(body.success, false);
    assert.equal(body.code, 'VALIDATION_ERROR');
    assert.equal(typeof body.message, 'string');
    assert.equal(typeof body.traceId, 'string');
    assert(body.errors !== undefined);
    const errors = body.errors as Record<string, string[]>;
    assert(errors.page !== undefined);
  });

  test('SEARCH-01: GET /api/v1/rooms/search?pageSize=99 trả về 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/rooms/search?pageSize=99`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, 'VALIDATION_ERROR');
    const errors = body.errors as Record<string, string[]>;
    assert(errors.pageSize !== undefined);
  });

  test('SEARCH-01: GET /api/v1/rooms/search?minPrice=5000000&maxPrice=3000000 trả về 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/rooms/search?minPrice=5000000&maxPrice=3000000`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, 'VALIDATION_ERROR');
    const errors = body.errors as Record<string, string[]>;
    assert(errors.maxPrice !== undefined);
  });

  test('SEARCH-01: GET /api/v1/rooms/search?sortBy=hack trả về 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/rooms/search?sortBy=hack`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, 'VALIDATION_ERROR');
    const errors = body.errors as Record<string, string[]>;
    assert(errors.sortBy !== undefined);
  });

  test('SEARCH-01: GET /api/v1/rooms/search?amenities=not-uuid trả về 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/rooms/search?amenities=not-uuid`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, 'VALIDATION_ERROR');
    const errors = body.errors as Record<string, string[]>;
    assert(errors.amenities !== undefined);
  });

  test('SEARCH-02: GET /api/v1/public/rooms/invalid-id trả về 400 INVALID_UUID', async () => {
    const res = await fetch(`${baseUrl}/api/v1/public/rooms/invalid-id`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;

    assert.equal(body.success, false);
    assert.equal(body.code, 'INVALID_UUID');
    assert.equal(typeof body.traceId, 'string');
    const errors = body.errors as Record<string, string[]>;
    assert(errors.roomId !== undefined);
  });

  test('SEARCH-02: GET /api/v1/public/rooms/{random-uuid-v4} trả về 404 ROOM_NOT_FOUND', async () => {
    const randomUuidV4 = '7b8f9e61-3d2a-4a5b-b1c2-d3e4f5a6b7c8';
    const res = await fetch(`${baseUrl}/api/v1/public/rooms/${randomUuidV4}`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as Record<string, unknown>;

    assert.equal(body.success, false);
    assert.equal(body.code, 'ROOM_NOT_FOUND');
    assert.equal(typeof body.message, 'string');
    assert.equal(typeof body.traceId, 'string');
  });
});
