import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { getCloudinaryClient } from '../../src/infrastructure/cloudinary/cloudinary.client';
import { MediaService } from '../../src/modules/media/media.service';

const undo: Array<() => void> = [];
afterEach(() => {
  while (undo.length) undo.pop()!();
});

function stub(delegate: any, name: string, implementation: (...args: any[]) => any) {
  const original = delegate[name];
  delegate[name] = implementation;
  undo.push(() => {
    delegate[name] = original;
  });
}

describe('MediaService', () => {
  test('uploadStream successfully streams buffer and resolves with secure_url', async () => {
    const client = getCloudinaryClient();
    stub(client.uploader, 'upload_stream', (options: any, callback: any) => {
      const { Writable } = require('node:stream');
      return new Writable({
        write(chunk: any, encoding: any, next: any) {
          next();
        },
        final(next: any) {
          callback(null, {
            secure_url: 'https://res.cloudinary.com/test-cloud/image/upload/v1/rentmate/test.webp',
            public_id: 'rentmate/test',
          });
          next();
        },
      });
    });

    const mediaService = new MediaService();
    const result = await mediaService.uploadStream(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), {
      publicId: 'rentmate/test',
    });

    assert.equal(result.secureUrl, 'https://res.cloudinary.com/test-cloud/image/upload/v1/rentmate/test.webp');
    assert.equal(result.publicId, 'rentmate/test');
  });

  test('uploadStream rejects with error when upload_stream fails', async () => {
    const client = getCloudinaryClient();
    stub(client.uploader, 'upload_stream', (options: any, callback: any) => {
      const { Writable } = require('node:stream');
      return new Writable({
        write(chunk: any, encoding: any, next: any) {
          next();
        },
        final(next: any) {
          callback(new Error('Cloudinary timeout'));
          next();
        },
      });
    });

    const mediaService = new MediaService();
    await assert.rejects(
      async () => {
        await mediaService.uploadStream(Buffer.from([0xff, 0xd8, 0xff]), { publicId: 'test' });
      },
      { message: 'Cloudinary timeout' }
    );
  });

  test('deleteResource calls cloudinary.uploader.destroy and returns true on success', async () => {
    const client = getCloudinaryClient();
    stub(client.uploader, 'destroy', async (publicId: string, options: any) => {
      assert.equal(publicId, 'rentmate/test');
      return { result: 'ok' };
    });

    const mediaService = new MediaService();
    const deleted = await mediaService.deleteResource('rentmate/test');
    assert.equal(deleted, true);
  });

  test('deleteResource returns false when destroy result is not ok or throws', async () => {
    const client = getCloudinaryClient();
    stub(client.uploader, 'destroy', async () => {
      throw new Error('Network error');
    });

    const mediaService = new MediaService();
    const deleted = await mediaService.deleteResource('rentmate/test');
    assert.equal(deleted, false);
  });
});
