// Provide mandatory env vars for src/env.ts validation during tests.
//
// For DATABASE_URL: shell env wins (CI sets it explicitly); then
// `.env.test`'s DATABASE_URL_TEST — the SAME base DB globalSetup
// migrates; then `.env` as a last resort; then a dummy URL that lets env
// validation pass for unit tests that mock Prisma.
//
// `.env.test` MUST outrank `.env`. It used to be the other way round,
// with two consequences on a serial run (`--runInBand`, which is what
// CI uses and what you reach for locally to debug):
//   1. globalSetup migrated the test DB while the app's prisma client
//      connected to the DEV database — so integration tests failed
//      against a schema nobody had migrated, or worse, PASSED by
//      writing to real development data.
//   2. `.env`'s URL points at PgBouncer (:5433), which is not part of
//      the test stack, so the failure surfaced as an unrelated
//      "Can't reach database server" rather than a config problem.
if (!process.env.DATABASE_URL) {
  const fs = require('fs');
  const path = require('path');
  const readUrl = (file, key) => {
    try {
      const content = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
      const match = content.match(new RegExp('^' + key + '="?([^"\\n]*)"?$', 'm'));
      return match && match[1] ? match[1] : null;
    } catch { return null; }
  };
  const resolved =
    readUrl('.env.test', 'DATABASE_URL_TEST') ||
    readUrl('.env.test', 'DATABASE_URL') ||
    readUrl('.env', 'DATABASE_URL');
  if (resolved) process.env.DATABASE_URL = resolved;
}
// Migrations and RLS setup need a DIRECT connection (never PgBouncer's
// transaction pooling). In tests they are the same URL.
if (!process.env.DIRECT_DATABASE_URL) {
  process.env.DIRECT_DATABASE_URL = process.env.DATABASE_URL;
}
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://user:password@localhost:5432/testdb';

// Per-worker DB isolation (flake fix): when globalSetup created one DB
// per Jest worker, repoint THIS worker's DATABASE_URL at its own clone
// so the app's prisma client and the test prisma client (db.ts
// getTestDatabaseUrl) connect to the SAME isolated DB. Without this the
// app writes to the base DB while the test reads the worker DB. Serial
// runs / CI (marker.perWorker === false) leave DATABASE_URL untouched.
try {
  const fs = require('fs');
  const path = require('path');
  // Repo-local marker path (see PER_WORKER_MARKER in tests/helpers/db.ts).
  const marker = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'node_modules/.cache/inflect-test-perworker.json'), 'utf8'),
  );
  if (marker.perWorker) {
    const u = new URL(marker.baseUrl);
    const wid = process.env.JEST_WORKER_ID || '1';
    u.pathname = '/' + marker.baseName + '_w' + wid;
    process.env.DATABASE_URL = u.toString();
    process.env.DIRECT_DATABASE_URL = u.toString();
  }
} catch { /* no marker → shared-DB mode, leave DATABASE_URL as resolved */ }
process.env.AUTH_SECRET = 'supersecretstringthatis16charplus'; // pragma: allowlist secret -- test fixture
process.env.JWT_SECRET = 'supersecretstringthatis16charplus'; // pragma: allowlist secret -- test fixture
process.env.GOOGLE_CLIENT_ID = 'test-google-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret'; // pragma: allowlist secret -- test fixture
process.env.MICROSOFT_CLIENT_ID = 'test-ms-id';
process.env.MICROSOFT_CLIENT_SECRET = 'test-ms-secret';
process.env.UPLOAD_DIR = 'uploads';
// Tests use local filesystem storage, never s3 (the default would require an
// S3_BUCKET). Root stays UPLOAD_DIR ('uploads') so storage tests' path
// expectations hold.
process.env.STORAGE_PROVIDER = process.env.STORAGE_PROVIDER || 'local';
// SKIP_ENV_VALIDATION drops Zod `.default()`s, so mirror the prod default
// (env.ts: SOIL_PROVIDER.default('soilgrids')) here — the soil read-time cache
// hydration filters SoilSample by `env.SOIL_PROVIDER`, and it must not be
// undefined under test.
process.env.SOIL_PROVIDER = process.env.SOIL_PROVIDER || 'soilgrids';
// #779: answer HIBP from a local fixture. `register-atomicity.test.ts` has no
// jest.mock and drives the real register POST three times, so the coverage
// lane made live api.pwnedpasswords.com requests on every PR. Assigned with
// `??=` so a test that needs the real default can still override it.
process.env.E2E_HIBP_FIXTURE ??= '1';
process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000';

// Note: tests/unit/env.test.ts clears this and runs in a separate process
// so it can still test the actual validation logic.
// We set this to prevent env loader from crashing other unit tests.
process.env.SKIP_ENV_VALIDATION = '1';

// Polyfill global fail() for guard tests (removed in newer Jest versions)
if (typeof globalThis.fail === 'undefined') {
  globalThis.fail = (message) => {
    throw new Error(typeof message === 'string' ? message : 'Test failed via fail()');
  };
}

// Jest's jsdom environment doesn't expose `TextEncoder` / `TextDecoder`
// on globalThis — Node has them, but Jest's jsdom stripping doesn't
// pass them through. Some unit tests use `@jest-environment jsdom`
// and transitively load `@prisma/client`, which pulls in `cuid2`
// → `@noble/hashes` → `new TextEncoder()` at module load. Without
// this polyfill those tests fail with "TextEncoder is not defined".
// Cheap workaround pinned to the Node-builtin implementation.
if (typeof globalThis.TextEncoder === 'undefined') {

  const { TextEncoder, TextDecoder } = require('node:util');
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
}
