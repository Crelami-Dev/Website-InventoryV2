/**
 * Phase 7G — Mandatory test bootstrap.
 *
 * Loaded with `node --import ./tests/bootstrap-env.mjs --test`.
 * Must be imported before any application module so that dotenv never
 * injects real credentials from backend/.env into a test process.
 */
process.env.NODE_ENV = 'test';
process.env.DOCUFLOW_TEST_ENV_READY = '1';

// `.invalid` is reserved by RFC 2606 and is guaranteed not to resolve.
process.env.SUPABASE_URL = 'https://docuflow-test.invalid';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

// Prevent accidental outbound SMTP if a test forgets to mock the transporter.
process.env.SMTP_HOST = 'smtp.test.invalid';
process.env.SMTP_PORT = '2525';
process.env.SMTP_SECURE = 'false';
process.env.SMTP_USER = 'test-user';
process.env.SMTP_PASS = 'test-pass';
process.env.SMTP_FROM = 'no-reply@test.invalid';
