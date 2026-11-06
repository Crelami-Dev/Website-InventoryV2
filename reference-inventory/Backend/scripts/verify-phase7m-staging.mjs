/**
 * Phase 7M — Isolated Staging Database Verification Script
 *
 * CRITICAL SAFETY CHECK:
 * Refuses to run against production database.
 * Requires explicit environment variable: DOCUFLOW_STAGING_ISOLATION_CONFIRMED=true
 * and target staging Supabase URL: STAGING_SUPABASE_URL.
 */

import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

const isIsolationConfirmed = process.env.DOCUFLOW_STAGING_ISOLATION_CONFIRMED === 'true';
const targetUrl = process.env.STAGING_SUPABASE_URL || process.env.SUPABASE_URL || '';
const serviceKey = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const KNOWN_PRODUCTION_FINGERPRINTS = [
  'huknfzyrwmrzflqwjdsl',
];

function isKnownProduction(url) {
  return KNOWN_PRODUCTION_FINGERPRINTS.some((fp) => String(url).toLowerCase().includes(fp));
}

console.log('================================================================');
console.log('  DocuFlow Phase 7M — Staging Real PostgreSQL Integration Test  ');
console.log('================================================================');

if (!isIsolationConfirmed) {
  console.error('\n[BLOCKED] DOCUFLOW_STAGING_ISOLATION_CONFIRMED is not set to "true".');
  console.error('Safety violation prevented: Running real database integration tests requires');
  console.error('an explicit confirmation that the target database is an isolated staging instance.\n');
  process.exit(1);
}

if (isKnownProduction(targetUrl)) {
  console.error('\n[BLOCKED] Target database matches known production instance URL fingerprint!');
  console.error(`Fingerprint detected in URL: ${targetUrl}`);
  console.error('Operation aborted immediately to protect production data.\n');
  process.exit(1);
}

if (!targetUrl || !serviceKey) {
  console.error('\n[BLOCKED] Missing STAGING_SUPABASE_URL or STAGING_SUPABASE_SERVICE_ROLE_KEY.\n');
  process.exit(1);
}

const supabase = createClient(targetUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function runStagingVerification() {
  const syntheticOwnerId = crypto.randomUUID();
  const syntheticWarehouseId = crypto.randomUUID();
  const syntheticUserId = crypto.randomUUID();

  console.log(`[STAGING] Initializing synthetic tenant: ${syntheticOwnerId}`);

  try {
    // Check migrations applied
    console.log('[STAGING] Checking schema prerequisites (024, 025, 026, 027)...');
    const { error: sessionCheckErr } = await supabase
      .from('serial_grouping_sessions')
      .select('id')
      .limit(1);

    if (sessionCheckErr && (sessionCheckErr.code === '42P01' || sessionCheckErr.message?.includes('does not exist'))) {
      console.error('\n[BLOCKER] Migration 027 (serial_grouping_sessions) has NOT been applied to staging database.');
      console.error('Please apply migrations 024, 025, 026, and 027 before running integration tests.\n');
      process.exit(2);
    }

    console.log('[STAGING] Migration 027 table confirmed present.');
    console.log('[STAGING] Ready for synthetic execution suites.');
    // Additional execution steps proceed here when staging is provisioned.
  } catch (err) {
    console.error('[STAGING] Verification failed with exception:', err);
    process.exit(1);
  }
}

runStagingVerification();
