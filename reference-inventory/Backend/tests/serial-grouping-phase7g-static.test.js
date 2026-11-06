import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const backendRoot = resolve(__dirname, '..');

const read = (...parts) => readFileSync(resolve(backendRoot, ...parts), 'utf8');

const atomicSql = read('supabase', 'migrations', '025_serial_grouping_full_atomic_rpc.sql');
const caseSql = read('supabase', 'migrations', '026_serial_case_insensitive_uniqueness.sql');
const serviceSrc = read('src', 'services', 'serialGroup.service.js');
const envSrc = read('src', 'config', 'env.js');
const bootstrapSrc = read('tests', 'bootstrap-env.mjs');
const packageJson = JSON.parse(read('package.json'));

const createFnStart = atomicSql.indexOf('CREATE OR REPLACE FUNCTION public.create_serial_group_full_atomic_v1');
const createFnEnd = atomicSql.indexOf('CREATE OR REPLACE FUNCTION public.ungroup_serial_full_atomic_v1');
const createFn = atomicSql.slice(createFnStart, createFnEnd);

describe('PHASE 7G — Static migration hardening audit', () => {
  describe('025: product lock defense-in-depth', () => {
    it('derives source products from locked rows and rejects a mismatched result product', () => {
      assert.ok(createFnStart > -1 && createFnEnd > createFnStart);
      assert.match(createFn, /count\(DISTINCT product_id\)/i);
      assert.match(createFn, /array_agg\(DISTINCT product_id\)/i);
      assert.match(createFn, /PRODUCT_LOCKED_SINGLE_SOURCE/);
      assert.match(createFn, /errcode = 'P0006'/);
      assert.match(createFn, /p_product_id IS DISTINCT FROM v_source_product_id/i);
    });

    it('checks the product lock before inserting the result serial (no partial writes)', () => {
      const lockPos = createFn.indexOf('PRODUCT_LOCKED_SINGLE_SOURCE');
      const insertPos = createFn.indexOf('INSERT INTO public.product_serials');
      assert.ok(lockPos > -1 && insertPos > lockPos, 'product lock must run before the first insert');
    });

    it('does not trust caller-supplied source product metadata', () => {
      assert.doesNotMatch(createFn, /p_source_product/i);
      assert.doesNotMatch(createFn, /sourceProducts/i);
      assert.doesNotMatch(createFn, /distinctProductCount/i);
    });

    it('uses case-insensitive, trimmed serial comparison for duplicates', () => {
      assert.match(createFn, /lower\(btrim\(serial_number\)\)\s*=\s*lower\(btrim\(p_group_serial_number\)\)/i);
    });

    it('keeps deterministic member lock ordering and never mutates products.stock', () => {
      assert.match(createFn, /ORDER BY id ASC\s+FOR UPDATE;/i);
      assert.doesNotMatch(atomicSql, /UPDATE public\.products\s+SET\s+stock/i);
    });
  });

  describe('026: owner-scoped case-insensitive uniqueness', () => {
    it('pre-checks case-insensitive duplicates and fails with a stable code', () => {
      assert.match(caseSql, /GROUP BY owner_id, lower\(btrim\(serial_number\)\)/i);
      assert.match(caseSql, /HAVING count\(\*\) > 1/i);
      assert.match(caseSql, /DUPLICATE_SERIAL_CASE_INSENSITIVE/);
      assert.match(caseSql, /errcode = 'P0007'/);
    });

    it('runs the duplicate check before creating the unique index', () => {
      const checkPos = caseSql.indexOf('DUPLICATE_SERIAL_CASE_INSENSITIVE');
      const indexPos = caseSql.indexOf('CREATE UNIQUE INDEX');
      assert.ok(checkPos > -1 && indexPos > checkPos);
    });

    it('creates an owner-scoped unique index on lower(btrim(serial_number))', () => {
      assert.match(
        caseSql,
        /CREATE UNIQUE INDEX IF NOT EXISTS product_serials_owner_lower_serial_number_key\s+ON public\.product_serials \(owner_id, lower\(btrim\(serial_number\)\)\)/i,
      );
    });

    it('drops only the superseded index and never rewrites historical serials', () => {
      assert.match(caseSql, /DROP INDEX IF EXISTS public\.product_serials_owner_serial_number_key/i);
      assert.doesNotMatch(caseSql, /UPDATE public\.product_serials/i);
      assert.doesNotMatch(caseSql, /DELETE FROM public\.product_serials/i);
      assert.doesNotMatch(caseSql, /MERGE INTO/i);
      assert.doesNotMatch(caseSql, /UPDATE public\.products/i);
    });

    it('is ordered after 000, 022, 024 and 025', () => {
      const migrations = readdirSync(resolve(backendRoot, 'supabase', 'migrations'))
        .filter((name) => /^\d{3}_.*\.sql$/.test(name))
        .sort();
      const indexOf = (prefix) => migrations.findIndex((name) => name.startsWith(prefix));
      assert.ok(indexOf('026_') > indexOf('025_'));
      assert.ok(indexOf('025_') > indexOf('024_'));
      assert.ok(indexOf('024_') > indexOf('022_'));
      assert.ok(indexOf('022_') > indexOf('000_'));
    });
  });

  describe('Service consistency', () => {
    it('normalises member identities case-insensitively before duplicate validation', () => {
      assert.match(serviceSrc, /new Set\(rawInputList\.map\(\(value\) => String\(value\)\.trim\(\)\.toLowerCase\(\)\)\)/);
      assert.match(serviceSrc, /new Set\(rawList\.map\(\(value\) => String\(value\)\.trim\(\)\.toLowerCase\(\)\)\)/);
    });

    it('resolves member serial numbers with a case-insensitive fallback', () => {
      assert.match(serviceSrc, /async function fetchGroupingMembers/);
      assert.match(serviceSrc, /\.ilike\('serial_number', escapeLikePattern\(sn\)\)/);
    });

    it('maps the RPC product-lock failure to the stable business code', () => {
      assert.match(serviceSrc, /message\.includes\('PRODUCT_LOCKED_SINGLE_SOURCE'\) \|\| code === 'P0006'/);
      assert.match(serviceSrc, /policyError\.code = 'PRODUCT_LOCKED_SINGLE_SOURCE'/);
    });

    it('looks up group serial numbers case-insensitively', () => {
      assert.match(serviceSrc, /query = query\.ilike\('serial_number', escapeLikePattern\(String\(groupSerialNumber\)\.trim\(\)\)\)/);
    });

    it('keeps the service-level product lock (new master + mismatched product)', () => {
      assert.match(serviceSrc, /if \(createNewMasterProduct\) \{[\s\S]*?PRODUCT_LOCKED_SINGLE_SOURCE/);
      assert.match(serviceSrc, /String\(resultProductId\) !== String\(sourceProductPolicy\.lockedResultProductId\)/);
    });

    it('does not introduce speculative product stock mutations', () => {
      assert.doesNotMatch(serviceSrc, /\.from\('products'\)[\s\S]{0,80}?\.update\(/);
    });
  });

  describe('Test bootstrap and environment guard', () => {
    it('bootstrap sets dummy values before app/config imports', () => {
      assert.match(bootstrapSrc, /process\.env\.NODE_ENV = 'test'/);
      assert.match(bootstrapSrc, /process\.env\.DOCUFLOW_TEST_ENV_READY = '1'/);
      assert.match(bootstrapSrc, /https:\/\/docuflow-test\.invalid/);
      assert.match(bootstrapSrc, /SUPABASE_ANON_KEY = 'test-anon-key'/);
      assert.match(bootstrapSrc, /SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'/);
    });

    it('config fails closed in the Node test runner without the bootstrap', () => {
      assert.match(envSrc, /if \(process\.env\.NODE_TEST_CONTEXT\)/);
      assert.match(envSrc, /DOCUFLOW_TEST_ENV_READY !== '1'/);
      assert.match(envSrc, /endsWith\('\.invalid'\)/);
      assert.match(envSrc, /Test environment bootstrap missing or unsafe/i);
    });

    it('package.json makes the safe bootstrap the official test path', () => {
      assert.match(packageJson.scripts.test, /node --import \.\/tests\/bootstrap-env\.mjs --test/);
    });
  });
});
