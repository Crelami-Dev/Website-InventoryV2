import 'dotenv/config';
import { z } from 'zod';

// PHASE 7G — Fail closed when the Node test runner is active without the
// mandatory dummy bootstrap. Production never sets NODE_TEST_CONTEXT, so this
// guard cannot change production behaviour.
if (process.env.NODE_TEST_CONTEXT) {
  const testUrl = process.env.SUPABASE_URL || '';
  let testHost = '';
  try {
    testHost = new URL(testUrl).hostname;
  } catch {
    testHost = '';
  }

  const isDummyUrl = testHost.endsWith('.invalid');
  const hasDummyKeys = String(process.env.SUPABASE_ANON_KEY || '').startsWith('test-')
    && String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').startsWith('test-');

  if (process.env.DOCUFLOW_TEST_ENV_READY !== '1'
      || process.env.NODE_ENV !== 'test'
      || !isDummyUrl
      || !hasDummyKeys) {
    throw new Error(
      'Test environment bootstrap missing or unsafe. Run tests with `npm test` '
      + '(tests/bootstrap-env.mjs) instead of invoking `node --test` directly.'
    );
  }
}

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  FRONTEND_ORIGIN: z.string().min(1).default('http://localhost:5173'),
  FRONTEND_URL: z.string().url().optional(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  NVIDIA_API_KEY: z.string().optional(),
  // Melindungi endpoint cron worker (GET/POST /api/cron/retry-emails) dari akses publik.
  // Vercel Cron otomatis mengirim header `Authorization: Bearer <CRON_SECRET>` saat
  // env var ini di-set di Project Settings. Opsional di env schema agar deployment yang
  // belum mengaktifkan cron tidak gagal start; endpoint sendiri menolak semua request
  // jika CRON_SECRET belum dikonfigurasi (lihat cron.routes.js).
  CRON_SECRET: z.string().min(1).optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  const hint = process.env.NODE_ENV === 'production'
    ? ' On Vercel, set these in the Project Settings → Environment Variables dashboard.'
    : ' Check your .env file against .env.example.';
  throw new Error(`Invalid backend environment: ${details}${hint}`);
}

export const env = parsed.data;
