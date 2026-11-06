import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(backendRoot, '..');

async function read(relativePath, root = backendRoot) {
  return readFile(path.join(root, relativePath), 'utf8');
}

describe('PHASE 7L - Fail-closed session persistence', () => {
  it('does not keep an in-memory session fallback', async () => {
    const source = await read('src/services/serialGroup.service.js');
    assert.doesNotMatch(source, /inMemorySessionStore/);
    assert.doesNotMatch(source, /getOwnerSessionStore/);
    assert.match(source, /GROUPING_SESSION_PERSISTENCE_FAILED/);
    assert.match(source, /databaseValidated:\s*true/);
  });

  it('creates sessions as Pending in the database before confirmation', async () => {
    const source = await read('src/services/serialGroup.service.js');
    const createBody = source.slice(
      source.indexOf('export async function createGroupingSession'),
      source.indexOf('export async function confirmGroupingSession'),
    );

    assert.match(createBody, /status:\s*'pending'/);
    assert.match(createBody, /\.from\('serial_grouping_sessions'\)/);
    assert.match(createBody, /isUniqueViolation/);
    assert.match(createBody, /confirmGroupingSession\(/);
    assert.doesNotMatch(createBody, /memStore/);
  });

  it('confirms through one atomic RPC without per-batch fallback', async () => {
    const source = await read('src/services/serialGroup.service.js');
    const confirmBody = source.slice(
      source.indexOf('export async function confirmGroupingSession'),
      source.indexOf('export async function cancelGroupingSession'),
    );

    assert.match(confirmBody, /confirm_serial_grouping_session_atomic_v1/);
    assert.match(confirmBody, /ATOMIC_SESSION_CONFIRM_UNAVAILABLE/);
    assert.match(confirmBody, /alreadyConfirmed/);
    assert.doesNotMatch(confirmBody, /processMultiSerialGroups/);
    assert.doesNotMatch(confirmBody, /memStore/);
  });

  it('lists and cancels sessions from the database only', async () => {
    const source = await read('src/services/serialGroup.service.js');
    const listBody = source.slice(
      source.indexOf('export async function listGroupingSessions'),
      source.indexOf('export async function getGroupingSessionDetails'),
    );
    const cancelBody = source.slice(
      source.indexOf('export async function cancelGroupingSession'),
      source.indexOf('export async function listGroupingSessions'),
    );

    assert.match(listBody, /sessionPersistenceError/);
    assert.doesNotMatch(listBody, /memStore|inMemory/);
    assert.match(cancelBody, /\.eq\('status', 'pending'\)/);
    assert.match(cancelBody, /GROUPING_SESSION_NOT_PENDING/);
    assert.doesNotMatch(cancelBody, /memStore|inMemory/);
  });

  it('removes the silent frontend fallback to legacy groupings', async () => {
    const page = await read('src/pages/SerialGrouping/SerialGroupingPage.jsx', path.join(repoRoot, 'frontend-new'));
    const fetchBody = page.slice(page.indexOf('const fetchGroupings'), page.indexOf('}, [statusFilter'));

    assert.match(fetchBody, /grouping-sessions/);
    assert.doesNotMatch(fetchBody, /product-serials\/groupings\$\{queryParams\}/);
    assert.doesNotMatch(fetchBody, /fallbackRes/);
    assert.match(page, /tanpa mengubah stok atau status nomor seri/);
  });
});

describe('PHASE 7L - Atomic session migration contract', () => {
  it('locks the session and rejects non-pending transitions', async () => {
    const migration = await read('supabase/migrations/027_serial_grouping_sessions.sql');

    assert.match(migration, /confirm_serial_grouping_session_atomic_v1/);
    assert.match(migration, /FROM public\.serial_grouping_sessions[\s\S]*FOR UPDATE/);
    assert.match(migration, /IF v_session\.status = 'completed' THEN/);
    assert.match(migration, /alreadyConfirmed/);
    assert.match(migration, /GROUPING_SESSION_NOT_PENDING/);
    assert.doesNotMatch(migration, /COMMIT\s*;/i);
  });

  it('processes all batches in one transaction and writes session_id', async () => {
    const migration = await read('supabase/migrations/027_serial_grouping_sessions.sql');

    assert.match(migration, /FOR v_batch IN SELECT value FROM jsonb_array_elements\(p_batches\)/);
    assert.match(migration, /public\.create_serial_group_full_atomic_v1\(/);
    assert.match(migration, /SET session_id = p_session_id/);
    assert.match(migration, /status = 'completed'/);
    assert.match(migration, /'processResult'/);
  });

  it('creates new master products inside the same transaction', async () => {
    const migration = await read('supabase/migrations/027_serial_grouping_sessions.sql');

    assert.match(migration, /INSERT INTO public\.products/);
    assert.match(migration, /v_new_product := v_batch->'new_product'/);
    assert.match(migration, /RETURNING id INTO v_product_id/);
  });

  it('restricts the RPC to service_role', async () => {
    const migration = await read('supabase/migrations/027_serial_grouping_sessions.sql');

    assert.match(migration, /SECURITY DEFINER/);
    assert.match(migration, /SET search_path = public, pg_temp/);
    assert.match(migration, /REVOKE ALL ON FUNCTION public\.confirm_serial_grouping_session_atomic_v1/);
    assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.confirm_serial_grouping_session_atomic_v1/);
  });
});
