import http from 'node:http';
import { app } from '../src/app';

async function main() {
  console.log('=== TEST LIVE BACKEND HTTP SERVER (PORT 5000) ===\n');

  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(5000, '127.0.0.1', () => {
      console.log('✔ RentMate Backend listening on http://127.0.0.1:5000\n');
      resolve();
    });
  });

  try {
    // 1. GET /health
    console.log('1. Testing GET /health ...');
    const healthRes = await fetch('http://127.0.0.1:5000/health');
    const healthBody = await healthRes.json();
    console.log(`   HTTP Status: ${healthRes.status}`);
    console.log(`   Response:`, JSON.stringify(healthBody));
    if (healthRes.status !== 200 || (healthBody as Record<string, unknown>).status !== 'ok') {
      throw new Error('Health check failed');
    }

    // 2. GET /api/v1/rooms/search
    console.log('\n2. Testing GET /api/v1/rooms/search (default query) ...');
    const searchRes = await fetch('http://127.0.0.1:5000/api/v1/rooms/search');
    const searchBody = (await searchRes.json()) as Record<string, unknown>;
    console.log(`   HTTP Status: ${searchRes.status}`);
    console.log(`   Response:`, JSON.stringify(searchBody));
    if (
      searchRes.status !== 200 ||
      !Array.isArray(searchBody.items) ||
      searchBody.page !== 1 ||
      searchBody.pageSize !== 12
    ) {
      throw new Error('SEARCH-01 default check failed');
    }

    // 3. GET /api/v1/rooms/search with filters
    console.log('\n3. Testing GET /api/v1/rooms/search?keyword=CMT8&province=TP.HCM&minPrice=2000000 ...');
    const filterRes = await fetch(
      'http://127.0.0.1:5000/api/v1/rooms/search?keyword=CMT8&province=TP.HCM&minPrice=2000000'
    );
    const filterBody = (await filterRes.json()) as Record<string, unknown>;
    console.log(`   HTTP Status: ${filterRes.status}`);
    console.log(`   Response:`, JSON.stringify(filterBody));
    if (filterRes.status !== 200) {
      throw new Error('SEARCH-01 filter check failed');
    }

    // 4. GET /api/v1/public/rooms/{roomId} with valid UUID v4 (not existing in DB)
    const testUuid = '7b8f9e61-3d2a-4a5b-b1c2-d3e4f5a6b7c8';
    console.log(`\n4. Testing GET /api/v1/public/rooms/${testUuid} ...`);
    const detailRes = await fetch(`http://127.0.0.1:5000/api/v1/public/rooms/${testUuid}`);
    const detailBody = (await detailRes.json()) as Record<string, unknown>;
    console.log(`   HTTP Status: ${detailRes.status}`);
    console.log(`   Response:`, JSON.stringify(detailBody));
    if (detailRes.status !== 404 || detailBody.code !== 'ROOM_NOT_FOUND') {
      throw new Error('SEARCH-02 404 check failed');
    }

    // 5. GET /api/v1/public/rooms/{invalid-uuid}
    console.log('\n5. Testing GET /api/v1/public/rooms/bad-uuid ...');
    const badIdRes = await fetch('http://127.0.0.1:5000/api/v1/public/rooms/bad-uuid');
    const badIdBody = (await badIdRes.json()) as Record<string, unknown>;
    console.log(`   HTTP Status: ${badIdRes.status}`);
    console.log(`   Response:`, JSON.stringify(badIdBody));
    if (badIdRes.status !== 400 || badIdBody.code !== 'INVALID_UUID') {
      throw new Error('SEARCH-02 400 invalid uuid check failed');
    }

    console.log('\n✔ ALL LIVE HTTP CHECKS PASSED PERFECTLY!\n');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    console.log('--- Server stopped safely ---');
  }
}

main().catch((err) => {
  console.error('Live test error:', err);
  process.exit(1);
});
