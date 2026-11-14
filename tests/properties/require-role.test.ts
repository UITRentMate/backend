import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { Request, Response } from 'express';
import { prisma } from '../../src/infrastructure/database/prisma';
import { ApiError } from '../../src/common/errors/api-error';
import { requireRole } from '../../src/common/middleware/require-role';

const undo: Array<() => void> = [];
afterEach(() => { while (undo.length) undo.pop()!(); });

function stub(delegate: any, name: string, implementation: (...args: any[]) => any) {
  const original = delegate[name];
  delegate[name] = implementation;
  undo.push(() => { delegate[name] = original; });
}

test('requireRole rejects when res.locals.userId is missing', async () => {
  const req = {} as Request;
  const res = { locals: {} } as Response;
  let errorCaught: any;
  const next = (err?: any) => { errorCaught = err; };

  const middleware = requireRole('LANDLORD');
  await middleware(req, res, next);

  assert.ok(errorCaught instanceof ApiError);
  assert.equal(errorCaught.statusCode, 401);
  assert.equal(errorCaught.code, 'UNAUTHORIZED');
});

test('requireRole rejects when user is not found in database', async () => {
  stub(prisma.user, 'findUnique', async () => null);

  const req = {} as Request;
  const res = { locals: { userId: '550e8400-e29b-41d4-a716-446655440000' } } as Response;
  let errorCaught: any;
  const next = (err?: any) => { errorCaught = err; };

  const middleware = requireRole('LANDLORD');
  await middleware(req, res, next);

  assert.ok(errorCaught instanceof ApiError);
  assert.equal(errorCaught.statusCode, 401);
  assert.equal(errorCaught.code, 'UNAUTHORIZED');
});

test('requireRole rejects when user accountStatus is not ACTIVE', async () => {
  stub(prisma.user, 'findUnique', async () => ({
    id: '550e8400-e29b-41d4-a716-446655440000',
    role: 'LANDLORD',
    accountStatus: 'LOCKED',
  }));

  const req = {} as Request;
  const res = { locals: { userId: '550e8400-e29b-41d4-a716-446655440000' } } as Response;
  let errorCaught: any;
  const next = (err?: any) => { errorCaught = err; };

  const middleware = requireRole('LANDLORD');
  await middleware(req, res, next);

  assert.ok(errorCaught instanceof ApiError);
  assert.equal(errorCaught.statusCode, 403);
  assert.equal(errorCaught.code, 'ACCOUNT_LOCKED');
});

test('requireRole rejects when user role does not match required role', async () => {
  stub(prisma.user, 'findUnique', async () => ({
    id: '550e8400-e29b-41d4-a716-446655440000',
    role: 'TENANT',
    accountStatus: 'ACTIVE',
  }));

  const req = {} as Request;
  const res = { locals: { userId: '550e8400-e29b-41d4-a716-446655440000' } } as Response;
  let errorCaught: any;
  const next = (err?: any) => { errorCaught = err; };

  const middleware = requireRole('LANDLORD');
  await middleware(req, res, next);

  assert.ok(errorCaught instanceof ApiError);
  assert.equal(errorCaught.statusCode, 403);
  assert.equal(errorCaught.code, 'FORBIDDEN');
});

test('requireRole passes and attaches currentUser when role and status match', async () => {
  const user = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    role: 'LANDLORD',
    accountStatus: 'ACTIVE',
  };
  stub(prisma.user, 'findUnique', async () => user);

  const req = {} as Request;
  const res = { locals: { userId: user.id } } as Response;
  let calledNext = false;
  let errorPassed: any;
  const next = (err?: any) => {
    calledNext = true;
    errorPassed = err;
  };

  const middleware = requireRole('LANDLORD');
  await middleware(req, res, next);

  assert.equal(calledNext, true);
  assert.equal(errorPassed, undefined);
  assert.deepEqual(res.locals.currentUser, user);
});
