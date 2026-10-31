// tests/mocks/env.ts
// This file mocks src/env.ts to bypass @t3-oss/env-nextjs ESM issues in Jest.
// It uses a Proxy to dynamically reflect process.env overrides in tests.
//
// ## Why the zod defaults are mirrored HERE and not in jest.setup.js — #2518
//
// `jest.setup.js` sets `SKIP_ENV_VALIDATION=1`, and `@t3-oss/env` then skips
// zod ENTIRELY — it does not validate and it does not apply defaults. So every
// `.default()` in `src/env.ts` was inert in every jest test and the variable
// read `undefined` rather than its declared value. 24 keys declare one.
//
// The instance that found it: `AV_SCAN_MODE` declares `.default("strict")` and
// `isDownloadAllowed` refuses a PENDING download only when the mode is
// `strict`, so under test it fell through to the permissive `return true`. The
// download gate was permissive in every unit test while declaring strict.
//
// **Mirroring belongs on this surface, not in `process.env`**, and the
// distinction is load-bearing rather than stylistic. This Proxy stands for the
// VALIDATED env, which is where a zod default lives; `process.env` is the raw
// environment, and code deliberately reads it raw to tell "an operator set
// this" from "nothing was configured and zod defaulted it". The worked example
// is `assertEmbeddingBackendConfigured` in `scripts/rag/corpus.ts`, whose own
// comment says it reads raw `process.env` precisely because
// `env.AI_BASE_URL` "always has a value (the zod default), so it can't
// distinguish 'operator set this' from 'nothing configured, defaulted to an
// unreachable localhost'". Putting the default in `process.env` would make
// that refusal unreachable. Putting it here leaves it alone.
//
// Resolution order, and each step earns its place:
//   1. `process.env` — so a test can still override anything, which is what
//      the original Proxy was for.
//   2. the explicit switch — TEST values that deliberately differ from
//      production, e.g. MICROSOFT_TENANT_ID is 'test-tenant' here and
//      'common' in production.
//   3. DECLARED_DEFAULTS — the production default, so a test sees what
//      production sees.
//
// `tests/guards/env-defaults-reach-the-tests.test.ts` derives the list from
// `src/env.ts` and fails when a new `.default()` is added without reaching
// this map, so the map cannot drift from the schema it mirrors.

/**
 * The `.default()` values declared in `src/env.ts`, which zod never applies
 * under `SKIP_ENV_VALIDATION=1`.
 *
 * Kept as data rather than switch arms so the guard can compare it against the
 * schema key by key. Entries whose production default is deliberately NOT used
 * under test belong in that guard's exemption map with a reason, never omitted
 * silently.
 */
export const DECLARED_DEFAULTS: Readonly<Record<string, string>> = {
    // Security posture. The reason this issue exists: the download gate read
    // `undefined` and served a PENDING (unscanned) file in every unit test.
    AV_SCAN_MODE: 'strict',
    // Empty-string defaults. Mirrored for fidelity rather than effect — code
    // testing falsiness behaves the same either way, but code asking
    // `=== undefined` does not, and the production answer is ''.
    LOOKUP_HMAC_KEY: '',
    NATIVE_AUTH_REDIRECT_ALLOWLIST: '',
    AI_RISK_PLAN_REQUIRED: '',
    // Outbound mail: the From address every email carries in production.
    SMTP_FROM: 'noreply@agrent.bg',
    // AI provider wiring. These reach `getProvider`/`routing`, and a test that
    // exercises them should see the self-hosted Ollama shape production
    // declares rather than `undefined` — `inferBackend(undefined)` answers a
    // different question from `inferBackend('http://localhost:11434/v1')`.
    AI_BACKEND: 'ollama',
    AI_BASE_URL: 'http://localhost:11434/v1',
    AI_API_KEY: 'ollama',
    AI_MODEL: 'qwen3:1.7b',
    AI_EMBED_MODEL: 'nomic-embed-text',
    VISION_BACKEND: 'auto',
    AI_EVAL_LLM_JUDGE: '0',
    AI_RISK_PROVIDER: 'stub',
    AI_RISK_ENABLED: 'true',
    // Cadastre WMS layer list.
    CADASTRE_WMS_LAYERS: 'CP.CadastralParcel',
    // Feature switch, off in production by default.
    AGRO_DATASTREAMS_ENABLED: '0',
    // Scheduling timezone. Four consumers pass it to BullMQ `tz` and to date
    // formatting; `undefined` there means "the machine's zone", which is the
    // ambient-timezone hazard a test cannot see.
    NOTIFICATIONS_TZ: 'Europe/London',
    // Client-inlined at build time in production; read from the environment here.
    NEXT_PUBLIC_MAP_BASEMAP_STYLE: 'hybrid',
    // Already mirrored before #2518, kept here so the guard sees one list.
    SOIL_PROVIDER: 'soilgrids',
    RATE_LIMIT_MODE: 'upstash',
    CORS_ALLOWED_ORIGINS: '',
    STORAGE_PROVIDER: 's3',
    NODE_ENV: 'development',
};

export const env = new Proxy({}, {
    get(target, prop: string) {
        // 1. An explicit override by the test always wins.
        if (process.env[prop] !== undefined) {
            return process.env[prop];
        }

        // 2. Values that deliberately differ from production under test.
        switch (prop) {
            case 'NODE_ENV': return 'test';
            case 'DATABASE_URL': return 'postgres://user:password@localhost:5432/testdb';
            case 'NEXTAUTH_URL': return 'http://localhost:3000';
            case 'AUTH_URL': return 'http://localhost:3000';
            case 'AUTH_SECRET': return 'supersecretstringthatis16charplus';
            case 'JWT_SECRET': return 'supersecretstringthatis16charplus';
            case 'GOOGLE_CLIENT_ID': return 'test-google-id';
            case 'GOOGLE_CLIENT_SECRET': return 'test-google-secret';
            case 'MICROSOFT_CLIENT_ID': return 'test-ms-id';
            case 'MICROSOFT_CLIENT_SECRET': return 'test-ms-secret';
            case 'MICROSOFT_TENANT_ID': return 'test-tenant';
            case 'UPLOAD_DIR': return 'uploads';
            case 'CORS_ALLOWED_ORIGINS': return 'https://myapp.com,http://localhost:3000';
            case 'RATE_LIMIT_ENABLED': return '1';
            case 'RATE_LIMIT_MODE': return 'upstash';
            case 'AUTH_TEST_MODE': return 'true';
            default: break;
        }

        // 3. The production default, which zod would have applied.
        if (prop in DECLARED_DEFAULTS) {
            return DECLARED_DEFAULTS[prop];
        }
        return undefined;
    }
});
