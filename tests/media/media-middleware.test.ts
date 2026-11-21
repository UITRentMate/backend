import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { uploadSingleImage, uploadMultipleImages } from '../../src/modules/media/media.middleware';

describe('Media Middleware', () => {
  test('uploadSingleImage returns an express RequestHandler', () => {
    const middleware = uploadSingleImage('image');
    assert.equal(typeof middleware, 'function');
  });

  test('uploadMultipleImages returns an express RequestHandler', () => {
    const middleware = uploadMultipleImages('images', 10);
    assert.equal(typeof middleware, 'function');
  });
});
