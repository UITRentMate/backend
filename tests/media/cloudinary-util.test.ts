import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  extractCloudinaryPublicId,
  buildPropertyCoverPublicId,
  buildRoomImagePublicId,
  validateImageBufferMagicBytes,
} from '../../src/common/utils/cloudinary.util';

describe('Cloudinary Utilities', () => {
  test('extractCloudinaryPublicId extracts publicId from standard Cloudinary URL', () => {
    const url = 'https://res.cloudinary.com/test-cloud/image/upload/v1731835000/rentmate/rooms/r-101/img-001.webp';
    const publicId = extractCloudinaryPublicId(url);
    assert.equal(publicId, 'rentmate/rooms/r-101/img-001');
  });

  test('extractCloudinaryPublicId handles url with transformation parameters and extension', () => {
    const url = 'https://res.cloudinary.com/test-cloud/image/upload/c_limit,w_1920/v1731835000/rentmate/properties/prop-1/cover_12345.jpg';
    const publicId = extractCloudinaryPublicId(url);
    assert.equal(publicId, 'rentmate/properties/prop-1/cover_12345');
  });

  test('extractCloudinaryPublicId returns null for non-cloudinary URL', () => {
    assert.equal(extractCloudinaryPublicId('https://example.com/avatar.png'), null);
    assert.equal(extractCloudinaryPublicId(''), null);
  });

  test('buildPropertyCoverPublicId creates structured path with prefix', () => {
    const publicId = buildPropertyCoverPublicId('prop-123');
    assert.ok(publicId.startsWith('rentmate/properties/prop-123/cover_'));
  });

  test('buildRoomImagePublicId creates structured path with room and image ids', () => {
    const publicId = buildRoomImagePublicId('room-123', 'img-456');
    assert.equal(publicId, 'rentmate/rooms/room-123/img-456');
  });

  test('validateImageBufferMagicBytes detects valid JPEG, PNG, WEBP', () => {
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    assert.equal(validateImageBufferMagicBytes(jpegBuffer).valid, true);
    assert.equal(validateImageBufferMagicBytes(jpegBuffer).format, 'jpeg');

    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(validateImageBufferMagicBytes(pngBuffer).valid, true);
    assert.equal(validateImageBufferMagicBytes(pngBuffer).format, 'png');

    const webpBuffer = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
    assert.equal(validateImageBufferMagicBytes(webpBuffer).valid, true);
    assert.equal(validateImageBufferMagicBytes(webpBuffer).format, 'webp');

    const invalidBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    assert.equal(validateImageBufferMagicBytes(invalidBuffer).valid, false);
  });
});
