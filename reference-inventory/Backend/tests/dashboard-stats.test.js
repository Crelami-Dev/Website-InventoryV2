import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('Dashboard Stats Endpoint Integrity', async (t) => {
  const routesPath = path.resolve('src/routes/workspace.routes.js');
  const content = fs.readFileSync(routesPath, 'utf8');

  await t.test('1. router.get("/dashboard/stats") includes all product stock KPI metrics in response payload', () => {
    assert.match(content, /totalProducts:\s*\(prods\s*\|\|\s*\[\]\)\.length/, 'Must include totalProducts');
    assert.match(content, /totalStock,/, 'Must include totalStock');
    assert.match(content, /lowStockCount,/, 'Must include lowStockCount');
    assert.match(content, /outOfStockCount,/, 'Must include outOfStockCount');
  });

  await t.test('2. router.get("/dashboard/stats") properly checks owner/super_admin when filtering by warehouse', () => {
    assert.match(content, /const isOwnerOrSuperAdmin = req\.auth\.role === 'owner' \|\| req\.auth\.role === 'super_admin';/);
    assert.match(content, /targetWhId = isOwnerOrSuperAdmin/);
  });
});
