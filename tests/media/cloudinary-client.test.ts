import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getCloudinaryClient } from '../../src/infrastructure/cloudinary/cloudinary.client';

test('getCloudinaryClient returns configured cloudinary instance with environment variables', () => {
  process.env.CLOUDINARY_CLOUD_NAME = 'test_cloud';
  process.env.CLOUDINARY_API_KEY = 'test_key';
  process.env.CLOUDINARY_API_SECRET = 'test_secret';

  const client = getCloudinaryClient();
  assert.ok(client);
  const config = client.config();
  assert.equal(config.cloud_name, 'test_cloud');
  assert.equal(config.api_key, 'test_key');
  assert.equal(config.api_secret, 'test_secret');
});
