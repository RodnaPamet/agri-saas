// Side effect — set Zod's `jitless` flag (browser only) before this
// module's own client env-validation parse, which would otherwise be the
// first thing to trigger Zod's CSP-violating `new Function` probe. See
// src/lib/zod-jitless.ts.
import '@/lib/zod-jitless';
import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';
import { DEV_FALLBACK_DATA_ENCRYPTION_KEY } from '@/lib/security/encryption-constants';

export const env = createEnv({
    /**
     * Specify your server-side environment variables schema here. This way you can ensure the app
     * isn't built with invalid env vars.
     */
    server: {
        NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
        DATABASE_URL: z.string().url(),
        // Direct connection to Postgres (bypasses PgBouncer).
        // Used by Prisma for migrations, schema push, and introspection.
        // Falls back to DATABASE_URL if not set (non-pooled environments).
        DIRECT_DATABASE_URL: z.string().url().optional(),

        // Redis (rate limits, BullMQ jobs, session/cache coordination)
        //
        // Schema layer carries the optional() shape so dev/test boots
        // without Redis (rate-limit middleware + audit-stream buffer
        // both fall back to in-memory). The production-required
        // contract is enforced by the per-field superRefine() below
        // (mirrors the GAP-03 DATA_ENCRYPTION_KEY pattern).
        //
        // GAP-13 — Redis is REQUIRED in production. Without it three
        // production-load-bearing practices collapse into no-ops:
        //   - login brute-force throttle (Epic A.3)
        //   - invite-redemption rate limit
        //   - email-dispatch rate limit
        // Refuse to boot rather than ship with the limits stripped.
        //
        // Production also requires the Redis URL to be AUTHENTICATED:
        // a bare `redis://host:6379` (no password) is rejected. An
        // unauthenticated Redis that is network-reachable is wide
        // open — anyone who can reach the port can read sessions,
        // dump rate-limit counters, and enqueue jobs. The URL must
        // parse and carry a non-empty password in its userinfo
        // (`redis://:PASSWORD@HOST:6379`, `redis://user:pw@host`, or
        // `rediss://:token@host` for TLS managed Redis). The
        // `rediss://` scheme is NOT required — a same-host compose
        // service on an internal docker network is acceptable with
        // password auth alone.
        REDIS_URL: z
            .string()
            .optional()
            .superRefine((val, ctx) => {
                if (process.env.NODE_ENV !== 'production') return;
                if (!val) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message:
                            'REDIS_URL is REQUIRED in production. ' +
                            'Rate limits, queues, and session coordination depend on it. ' +
                            'Set REDIS_URL to your Redis / ElastiCache connection string ' +
                            '(e.g. redis://:PASSWORD@HOST:6379) before deploying.',
                    });
                    return;
                }
                let url: URL;
                try {
                    url = new URL(val);
                } catch {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message:
                            'REDIS_URL is not a valid URL. ' +
                            'Expected redis://:PASSWORD@HOST:6379 ' +
                            '(or rediss:// for TLS).',
                    });
                    return;
                }
                if (!url.password) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message:
                            'REDIS_URL must be AUTHENTICATED in production. ' +
                            'A bare redis://HOST:6379 leaves Redis open to anyone ' +
                            'who can reach the port — sessions, rate-limit counters, ' +
                            'and the job queue all live there. Set a password: ' +
                            'redis://:PASSWORD@HOST:6379 (or rediss:// for TLS).',
                    });
                }
            }),

        // NextAuth
        NEXTAUTH_URL: z.preprocess(
            // This makes Vercel deployments not fail if you don't set NEXTAUTH_URL
            // Since NextAuth automatically uses the VERCEL_URL if present.
            (str) => process.env.VERCEL_URL ? process.env.VERCEL_URL : str,
            process.env.VERCEL ? z.string().optional() : z.string().url()
        ),
        AUTH_URL: z.preprocess(
            (str) => process.env.VERCEL_URL ? process.env.VERCEL_URL : str,
            process.env.VERCEL ? z.string().optional() : z.string().url()
        ),
        AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be at least 16 characters long"),
        JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters long"),

        // Providers
        GOOGLE_CLIENT_ID: z.string().min(1, "Google Client ID is required"),
        GOOGLE_CLIENT_SECRET: z.string().min(1, "Google Client Secret is required"),
        MICROSOFT_CLIENT_ID: z.string().min(1, "Microsoft Client ID is required"),
        MICROSOFT_CLIENT_SECRET: z.string().min(1, "Microsoft Client Secret is required"),
        MICROSOFT_TENANT_ID: z.string().default("common"),

        // Rate Limiting
        RATE_LIMIT_ENABLED: z.enum(["0", "1"]).optional(),
        RATE_LIMIT_MODE: z.enum(["upstash", "memory"]).default("upstash"),
        AUTH_TEST_MODE: z.enum(["0", "1"]).optional(),
        // When "1", the Credentials provider rejects sign-ins whose User row
        // has `emailVerified = null`. See src/lib/auth/credentials.ts. Default
        // is OFF so existing deployments behave unchanged until verification
        // flow ships.
        AUTH_REQUIRE_EMAIL_VERIFICATION: z.enum(["0", "1"]).optional(),
        UPSTASH_REDIS_REST_URL: z.string().url().optional(),
        UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),

        // File Storage
        UPLOAD_DIR: z.string().min(1, "UPLOAD_DIR must be specified"),
        FILE_STORAGE_ROOT: z.string().optional(),
        FILE_MAX_SIZE_BYTES: z.coerce.number().optional(),
        FILE_ALLOWED_MIME: z.string().optional(),

        // Cloud Storage (S3/R2/MinIO)
        STORAGE_PROVIDER: z.enum(["local", "s3"]).default("s3"),
        S3_BUCKET: z.string().optional(),
        S3_REGION: z.string().optional(),
        S3_ENDPOINT: z.string().optional(),
        S3_ACCESS_KEY_ID: z.string().optional(),
        S3_SECRET_ACCESS_KEY: z.string().optional(),

        // AV Scanning
        AV_WEBHOOK_SECRET: z.string().optional(),          // HMAC secret for webhook auth
        AV_SCAN_MODE: z.enum(["strict", "permissive", "disabled"]).default("strict"),
        CLAMAV_HOST: z.string().optional(),                  // ClamAV daemon host (e.g. clamav:3310)

        // Data Protection (Epic 8) — GAP-03 enforcement.
        //
        // Schema layer: optional() carries the *shape* (string ≥32 chars
        // when present). The production-required + dev-fallback-rejection
        // contract is enforced by the per-field superRefine() below,
        // which reads the same `process.env.NODE_ENV` the schema is
        // about to validate. Two-stage so the field-level error message
        // points at DATA_ENCRYPTION_KEY rather than a top-level object
        // refinement that prints the whole env shape.
        DATA_ENCRYPTION_KEY: z
            .string()
            .min(32, "DATA_ENCRYPTION_KEY must be at least 32 characters")
            .optional()
            .superRefine((val, ctx) => {
                // GAP-03 — production cannot boot without an encryption
                // key. Read NODE_ENV from process.env directly because
                // the parsed `env.NODE_ENV` is not yet available at
                // refine time (zod parses fields independently).
                if (process.env.NODE_ENV !== 'production') return;
                if (!val) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message:
                            'DATA_ENCRYPTION_KEY is REQUIRED in production. ' +
                            'Generate with: openssl rand -base64 48',
                    });
                    return;
                }
                if (val === DEV_FALLBACK_DATA_ENCRYPTION_KEY) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message:
                            'DATA_ENCRYPTION_KEY equals the documented dev ' +
                            'fallback. Refusing to boot — generate a real ' +
                            'key with: openssl rand -base64 48',
                    });
                }
            }),
        // Epic B.3 — master KEK rotation. When set, the old key is used
        // as a decrypt fallback for any ciphertext the new primary KEK
        // can't read. Encryption always uses DATA_ENCRYPTION_KEY
        // (primary). Remove this var ONCE the rotation job reports zero
        // remaining v1 rows under the previous key.
        DATA_ENCRYPTION_KEY_PREVIOUS: z.string().min(32).optional(),

        // Security / CORS
        CORS_ALLOWED_ORIGINS: z.string().default(""),

        // SMTP / Email (all optional — when SMTP_HOST is absent, console sink is used)
        SMTP_HOST: z.string().optional(),
        SMTP_PORT: z.coerce.number().optional(),
        SMTP_USER: z.string().optional(),
        SMTP_PASS: z.string().optional(),
        SMTP_FROM: z.string().default("noreply@agrent.bg"),

        // Resend (https://resend.com) — preferred over SMTP when set. Uses
        // Resend's HTTPS API (no SMTP egress needed). RESEND_FROM must be a
        // Resend-verified sender; it falls back to SMTP_FROM when omitted.
        RESEND_API_KEY: z.string().optional(),
        RESEND_FROM: z.string().optional(),

        // Stripe Billing
        STRIPE_SECRET_KEY: z.string().optional(),
        STRIPE_WEBHOOK_SECRET: z.string().optional(),
        STRIPE_PRICE_ID_PRO: z.string().optional(),
        STRIPE_PRICE_ID_ENTERPRISE: z.string().optional(),
        APP_URL: z.string().url().optional(),

        // AI Risk Assessment
        AI_RISK_PROVIDER: z.string().default('stub'),
        OPENROUTER_API_KEY: z.string().optional(),
        OPENROUTER_MODEL: z.string().optional(),

        // ── Soil integration (#37) ──
        // Per-parcel soil comes from ISRIC SoilGrids (open, CC-BY 4.0).
        // SOIL_PROVIDER selects the client ("soilgrids" today). SOIL_BASE_URL
        // overrides the endpoint — point it at a self-hosted SoilGrids/
        // OpenLandMap mirror (same query shape) as the fallback when the beta
        // public REST API is rate-limited or down. Both optional; defaults
        // live in the client so soil "just works" out of the box.
        SOIL_PROVIDER: z.string().default('soilgrids'),
        SOIL_BASE_URL: z.string().url().optional(),

        // ── Market-price trends backbone (feat/trends-data-backbone) ──
        // Optional overrides for the market-price pull job. Both OPTIONAL:
        // EC_AGRIFOOD_BASE_URL overrides the EC AGRI-food API endpoint (point
        // it at a mirror/proxy; defaults live in the client). ALPHA_VANTAGE_API_KEY
        // enables the Alpha Vantage global reference feed — when UNSET the
        // Alpha Vantage source is simply skipped by the pull. Mirrors the
        // SOIL_BASE_URL pattern (feature degrades gracefully when unset).
        EC_AGRIFOOD_BASE_URL: z.string().url().optional(),
        ALPHA_VANTAGE_API_KEY: z.string().optional(),
        // BARCHART_API_KEY enables the Barchart OnDemand delayed-futures feed
        // (Euronext MATIF wheat/corn benchmark). UNSET → the Barchart source is
        // skipped by the pull, exactly like the Alpha Vantage key. Requires a
        // per-exchange redistribution licence before showing to end users.
        BARCHART_API_KEY: z.string().optional(),

        // ── Market-news feeds (feat/trends-news-tab) ──
        // Optional JSON override for the RSS/Atom feeds the market-news-pull job
        // aggregates into the Trends → News tab: a JSON array of
        // `{ slug, url, category }` (category ∈ market|policy|general). SERVER-ONLY
        // + OPTIONAL — when unset the curated defaults in src/lib/news/feeds.ts
        // are used; a malformed value also falls back to the defaults. Lets an
        // operator retune sources (a feed dies / a better one appears) without a
        // redeploy. The pull is fail-soft per feed, so a bad URL just yields no
        // items.
        MARKET_NEWS_FEEDS: z.string().optional(),

        // ── КАИС cadastre OpenData import (feat/cadastre-opendata-import) ──
        // Base URL of the Bulgarian cadastre (АГКК) OpenData portal
        // (https://kais.cadastre.bg). SERVER-ONLY + OPTIONAL: when unset the
        // "import from the cadastre" feature is HIDDEN (the UI tab is gated on a
        // server-computed boolean; the URL is NEVER exposed to the client).
        // Mirrors the SOIL_BASE_URL pattern.
        CADASTRE_OPENDATA_INDEX_URL: z.string().url().optional(),

        // ── Bulgarian cadastre (КККР / АГКК) WMS overlay ──
        // Opt-in, operator-configured seam for the toggleable cadastral-parcel
        // overlay on the location map. ALL optional — the overlay is HIDDEN
        // (the toggle never renders) unless an upstream is configured, which is
        // the correct default: the free INSPIRE view WMS for КККР parcels could
        // not be located by probing, and a hardcoded URL that 404s is worse
        // than nothing. See docs/implementation-notes/2026-07-13-cadastre-wms-
        // overlay.md for the discovery outcome + the paid №8002 commercial
        // terms. The resolved URL is SERVER-ONLY — never NEXT_PUBLIC — because
        // a №8002 licence is IP-bound to the VM, so tiles must be fetched from
        // the server via the same-origin proxy, never the browser. The client
        // only ever sees a `configured` boolean + the same-origin tile URL.
        //   CADASTRE_WMS_URL         — free INSPIRE GetMap base URL.
        //   CADASTRE_WMS_LAYERS      — WMS LAYERS value (INSPIRE default).
        //   CADASTRE_WMS_PREMIUM_URL — paid №8002 GetMap base; wins when set.
        CADASTRE_WMS_URL: z.string().url().optional(),
        CADASTRE_WMS_LAYERS: z.string().default('CP.CadastralParcel'),
        CADASTRE_WMS_PREMIUM_URL: z.string().url().optional(),

        // ── Bulgarian cadastre (КККР / АГКК) VECTOR parcels overlay ──
        // The FREE default that actually renders: an ArcGIS FeatureServer-style
        // layer (spp.api.bg CadBaseMap MapServer/2) whose `/query` returns
        // GeoJSON parcel polygons reprojected server-side to EPSG:4326. When set,
        // the location-map cadastre toggle drives this VECTOR boundary overlay
        // (preferred over the raster WMS path above). SERVER-ONLY + OPTIONAL —
        // the overlay stays hidden unless configured; the resolved URL is fetched
        // server-side via the same-origin `/cadastre/parcels` proxy and NEVER
        // reaches the browser (the client sees only a `configured` boolean + the
        // same-origin endpoint). Mirrors the SOIL_BASE_URL pattern.
        CADASTRE_PARCELS_URL: z.string().url().optional(),

        // ── Swappable AI provider (feat/ai-provider) ──
        // ONE OpenAI-compatible provider serves local dev (Ollama) and
        // any hosted backend (OpenRouter / Groq / Together) — they differ
        // only by base URL + key + model. Dev defaults point at a local
        // Ollama server (zero API cost, clean-licensed qwen3:1.7b), so
        // local dev works with NO configuration. Prod swaps the backend
        // purely by setting these env vars.
        //   AI_BACKEND   — explicit backend hint; when unset it is inferred
        //                  from the base-URL host (openrouter.ai → openrouter,
        //                  groq → groq, together → together, else ollama).
        //                  Drives the per-backend capability map.
        //   AI_BASE_URL  — OpenAI-compatible base (…/v1).
        //   AI_API_KEY   — bearer key. Ollama ignores it but the SDK needs a
        //                  non-empty string, hence the 'ollama' default.
        //   AI_MODEL     — model id (qwen3:1.7b locally).
        //   AI_EMBED_MODEL — embedding model for RAG (feat/ai-rag). 768-dim
        //                  nomic-embed-text by default (matches the
        //                  KnowledgeChunk.embedding vector(768) column).
        //   AI_BACKEND='claude' — native Anthropic Messages-API backend
        //                  (ClaudeProvider). When selected, the provider
        //                  uses ANTHROPIC_API_KEY (+ optional
        //                  ANTHROPIC_BASE_URL) and AI_MODEL as the model
        //                  id, rather than AI_BASE_URL / AI_API_KEY.
        AI_BACKEND: z
            .enum(['ollama', 'openrouter', 'groq', 'together', 'openai-compatible', 'claude'])
            .default('ollama'),
        AI_BASE_URL: z.string().url().default('http://localhost:11434/v1'),
        AI_API_KEY: z.string().min(1).default('ollama'),
        AI_MODEL: z.string().min(1).default('qwen3:1.7b'),
        AI_EMBED_MODEL: z.string().min(1).default('nomic-embed-text'),
        // ── Native Claude backend (feat/ai-prod-routing) ──
        // Used only when AI_BACKEND='claude'. ANTHROPIC_API_KEY is the
        // bearer key; ANTHROPIC_BASE_URL optionally points at a proxy /
        // gateway (Anthropic's default host when unset).
        ANTHROPIC_API_KEY: z.string().optional(),
        ANTHROPIC_BASE_URL: z.string().url().optional(),
        // ── Embedding provider — resolved INDEPENDENTLY of AI_BACKEND ──
        // (fix/rag-embedding-provider-split). Anthropic exposes no
        // embeddings endpoint, so `getAiProvider().embed()` throws
        // whenever AI_BACKEND='claude' — that used to silently disable
        // RAG ingestion + retrieval. `getEmbeddingProvider()` (see
        // src/app-layer/ai/provider/index.ts) resolves a SEPARATE
        // OpenAiCompatibleProvider from these three vars, all optional:
        // unset, they fall back to AI_EMBED_BACKEND → inferred from
        // AI_EMBED_BASE_URL ?? AI_BASE_URL, and AI_EMBED_API_KEY ??
        // AI_API_KEY — i.e. local dev's Ollama-serves-both default keeps
        // working with zero extra config. In production (Option B —
        // see deploy/env.prod.example), point these at a hosted
        // OpenAI-compatible embedding API (e.g. OpenAI, OpenRouter, or
        // a self-hosted TEI endpoint) so retrieval works independently
        // of whichever backend serves completions. Left unset, RAG
        // retrieval degrades to keyword-only (never throws — see
        // src/app-layer/ai/rag/retrieve.ts) rather than 500ing.
        AI_EMBED_BACKEND: z
            .enum(['ollama', 'openrouter', 'groq', 'together', 'openai-compatible'])
            .optional(),
        AI_EMBED_BASE_URL: z.string().url().optional(),
        AI_EMBED_API_KEY: z.string().min(1).optional(),

        // ── Vision subsystem (feat/ai-vision) — leaf/crop photo → pest/disease ──
        //   VISION_BACKEND    — orchestrator policy. 'auto' (default) tries the
        //                       on-device ONNX model first and falls back to
        //                       Claude when the model is absent OR confidence
        //                       is below the fallback threshold. 'onnx' /
        //                       'claude' pin a single backend.
        //   VISION_MODEL_PATH — absolute path to the ONNX classifier weights
        //                       (CropNet / MobileNetV2-PlantVillage, Apache-2.0).
        //                       Optional — when unset/missing the ONNX backend
        //                       reports unavailable and the orchestrator uses
        //                       Claude. The weights are NEVER vendored into the
        //                       repo — see THIRD_PARTY_NOTICES.md for setup.
        //   VISION_LABELS_PATH — optional newline-delimited labels file that
        //                       overrides the bundled PlantVillage class list
        //                       (use when pointing VISION_MODEL_PATH at a model
        //                       with a different class taxonomy).
        VISION_BACKEND: z.enum(['auto', 'onnx', 'claude']).default('auto'),
        VISION_MODEL_PATH: z.string().optional(),
        VISION_LABELS_PATH: z.string().optional(),

        AI_RISK_DAILY_QUOTA: z.string().optional(),
        AI_RISK_USER_RPM: z.string().optional(),
        AI_RISK_ENABLED: z.string().default('true'),
        AI_RISK_PLAN_REQUIRED: z.string().default(''),

        // ── AI eval harness (feat/ai-evals-safety) ──
        // Opt-in flag for the LLM-judge rubric scorer in the offline eval
        // runner (`scripts/ai/eval/run.ts`). '1' enables the live-model
        // judge + any case that needs a model; the CI default ('0') runs
        // the deterministic exact/contains + safety-behaviour subset with
        // no secrets and never touches a live backend.
        AI_EVAL_LLM_JUDGE: z.enum(['0', '1']).default('0'),

        // ── AI guardrails (feat/ai-guardrails) ──
        //   AI_CACHE_TTL_SECONDS       — Redis TTL for cached deterministic
        //                                completion responses. Default 3600.
        //   AI_EMBED_CACHE_TTL_SECONDS — Redis TTL for cached query/text
        //                                embeddings (longer — embeddings are
        //                                fully deterministic). Default 30 days.
        //   AI_RATE_LIMIT_PER_MIN      — per-(tenant,user) AI completion rate
        //                                ceiling per minute. Default 30.
        // All optional with sane defaults so AI works with zero config; an
        // operator tunes throughput/abuse posture by setting them.
        AI_CACHE_TTL_SECONDS: z.coerce.number().int().positive().optional(),
        AI_EMBED_CACHE_TTL_SECONDS: z.coerce.number().int().positive().optional(),
        AI_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().optional(),
        // ── Dhenu2 A/B eval hook (feat/ai-guardrails, OPTIONAL) ──
        // When set to a base URL + model (`<baseURL>|<model>`), the offline
        // eval harness runs the agronomy suites a SECOND time against this
        // operator-supplied endpoint and reports it side-by-side with the
        // default (general + RAG) backend. Default unset → no A/B run; CI is
        // unaffected. NO model is bundled — see docs/ai-data-flow.md for the
        // Dhenu2 licence note. Read only by scripts/ai/eval/* (eval-only).
        AI_EVAL_AB_BACKEND: z.string().optional(),

        // Agro-intel — sensor/data-stream ingestion endpoint feature flag.
        // '1' enables the token-gated POST ingestion route; anything else
        // (default) returns 503 feature_disabled. Off by default — the
        // stream-definition CRUD is always available; only live ingestion
        // is flagged so an operator opts in before exposing the endpoint.
        AGRO_DATASTREAMS_ENABLED: z.enum(['0', '1']).default('0'),

        // Agro-intel — NDVI raster tile source for the location map's
        // satellite-vegetation overlay. An XYZ `{z}/{x}/{y}` template URL.
        // Google Earth Engine (NDVI overlay). Both OPTIONAL — when either
        // is unset the NDVI service reports "not configured" and the map
        // overlay stays off, so CI + contributor builds need no GEE creds.
        // GEE_PROJECT_ID is the Earth-Engine-registered Cloud project;
        // GEE_SERVICE_ACCOUNT_KEY is the FULL service-account JSON key as a
        // single string (parsed at runtime, server-only — never NEXT_PUBLIC).
        GEE_PROJECT_ID: z.string().optional(),
        GEE_SERVICE_ACCOUNT_KEY: z.string().optional(),

        // Audit stream delivery retry (Epic E.2)
        // '0' disables retry (single POST); anything else (or unset) keeps retry on.
        // Kill-switch for debugging a misbehaving SIEM without redeploy.
        AUDIT_STREAM_RETRY_ENABLED: z.string().optional(),

        // Outbound-webhook legacy header dual-emit (Roadmap-5 PR3 brand migration)
        // '0' emits ONLY the canonical X-Agrent-* headers; unset / '1' (default)
        // ALSO emits the legacy X-Inflect-* headers with identical values, so
        // existing tenant SIEM integrations keep working during the deprecation
        // window. Read via process.env in webhook-headers.ts (operator toggle).
        AUDIT_STREAM_LEGACY_HEADERS: z.enum(["0", "1"]).optional(),

        // Epic 1, PR 2 — Platform-admin API key.
        // Optional platform-scoped secret for the tenant-creation endpoint
        // (POST /api/admin/tenants). Keep out of tenant env — inject via
        // orchestrator or secret-manager only. When unset, the endpoint
        // returns 503 "Platform admin API not configured".
        PLATFORM_ADMIN_API_KEY: z.string().min(32).optional(),

        // R-4: zero-downtime rotation. During key swap, set this to the
        // OUTGOING key alongside the new PLATFORM_ADMIN_API_KEY. The
        // verifier accepts either; once you've confirmed callers use the
        // new key, drop this from env. Same shape as
        // DATA_ENCRYPTION_KEY_PREVIOUS.
        PLATFORM_ADMIN_API_KEY_PREVIOUS: z.string().min(32).optional(),

        // #12 — slug of the tenant whose admins curate the GLOBAL catalogues
        // (companies + promotions) from the support console. Distinct from the
        // API key above: that is a session-less shared secret for machine
        // callers, this designates a tenant whose real, logged-in admins do
        // recurring human curation — so audit rows carry a real userId.
        //
        // UNSET = the console is unreachable for every tenant (fail closed).
        // Never default this: a blank value that matched any slug would hand
        // every farm's owner write access to every other farm's feed.
        PLATFORM_TENANT_SLUG: z.string().min(1).optional(),

        // Contact address shown on the public /privacy page. The data
        // CONTROLLER is the organisation operating this deployment, not the
        // software, so the address cannot be baked in. UNSET renders no contact
        // block at all rather than a placeholder that reads as a real address.
        PRIVACY_CONTACT_EMAIL: z.string().email().optional(),

        // Local zone for task-due deadline notifications — sets BOTH the
        // cron firing time AND the calendar-day classification ("due
        // today / tomorrow / in a week"). Must be one zone so a task
        // due near local midnight is not mis-bucketed. IANA zone name,
        // DST-aware; defaults to Europe/London.
        NOTIFICATIONS_TZ: z
            .string()
            .default('Europe/London')
            .refine(
                (val) => {
                    try {
                        // A bad zone makes the formatter throw RangeError.
                        new Intl.DateTimeFormat('en-US', { timeZone: val });
                        return true;
                    } catch {
                        return false;
                    }
                },
                { message: 'NOTIFICATIONS_TZ must be a valid IANA timezone' },
            ),

        // ── Web Push (VAPID) ──
        // All optional: Web Push is opt-in. When the key pair is unset the
        // push layer is a silent no-op (subscribe endpoint 503s, sends skip),
        // so dev/CI/self-hosted run without push configured. Generate a pair
        // with `npx web-push generate-vapid-keys`.
        VAPID_PUBLIC_KEY: z.string().optional(),
        VAPID_PRIVATE_KEY: z.string().optional(),
        // `mailto:` or https contact URL embedded in the push request (push
        // services use it to reach you about delivery problems).
        VAPID_SUBJECT: z.string().optional(),
    },

    /**
     * Specify your client-side environment variables schema here. This way you can ensure the app
     * isn't built with invalid env vars. To expose them to the client, prefix them with
     * `NEXT_PUBLIC_`.
     */
    client: {
        // PR-C 2026-05-27 — opt-in flag for the SSE notification
        // bell. Off by default (the bell stays on REST polling)
        // until the client integration is verified end-to-end in
        // a real browser. Server-side stream is wired regardless;
        // flipping this to '1' is the only step to engage SSE.
        NEXT_PUBLIC_NOTIFICATIONS_SSE: z.enum(['0', '1']).optional(),

        // The VAPID public key, exposed to the browser so the client can
        // subscribe via PushManager. Mirror of VAPID_PUBLIC_KEY; absent →
        // the push opt-in UI stays hidden (feature-detected + key-gated).
        NEXT_PUBLIC_VAPID_PUBLIC_KEY: z.string().optional(),

        // MapTiler basemap (parcel map). The key is fetched by MapLibre
        // in the browser, so it is necessarily public — restrict it by
        // HTTP referrer in the MapTiler dashboard rather than treating it
        // as a secret. Absent → MapCanvas falls back to the bare
        // `demotiles.maplibre.org` style (no imagery), so the map keeps
        // working without any signup.
        NEXT_PUBLIC_MAPTILER_KEY: z.string().optional(),

        // Which MapTiler style id to render. Defaults to `hybrid`
        // (satellite imagery + road/place labels) — the best fit for an
        // agriculture product, where operators navigate by what their
        // land looks like. Only consulted when NEXT_PUBLIC_MAPTILER_KEY
        // is set.
        NEXT_PUBLIC_MAP_BASEMAP_STYLE: z
            .enum(['hybrid', 'satellite', 'streets-v2', 'outdoor-v2', 'basic-v2'])
            .default('hybrid'),

        // ── Sentry (browser error reporting) ──
        // The client Sentry SDK is gated on this DSN: absent ⇒ no-op (a
        // self-hosted deploy stays clean), mirroring how VAPID gates web push.
        // `RELEASE` tags field crashes to a specific deploy.
        /**
         * OVERRIDE for the operator's own privacy notice. The app now ships an
         * in-app `/privacy` page, which the consent notice links to by default;
         * set this only when a deployment hosts its own policy elsewhere and
         * wants the link to point there instead.
         */
        NEXT_PUBLIC_PRIVACY_URL: z.string().url().optional(),
        NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
        NEXT_PUBLIC_SENTRY_RELEASE: z.string().optional(),
    },

    /**
     * You can't destruct `process.env` as a regular object in the Next.js edge runtimes (e.g.
     * middlewares) or client-side so we need to destruct manually.
     */
    runtimeEnv: {
        NODE_ENV: process.env.NODE_ENV,
        DATABASE_URL: process.env.DATABASE_URL,
        DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL,
        REDIS_URL: process.env.REDIS_URL,
        NEXTAUTH_URL: process.env.NEXTAUTH_URL,
        AUTH_URL: process.env.AUTH_URL,
        AUTH_SECRET: process.env.AUTH_SECRET,
        JWT_SECRET: process.env.JWT_SECRET,

        GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
        MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
        MICROSOFT_CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET,
        MICROSOFT_TENANT_ID: process.env.MICROSOFT_TENANT_ID,

        RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED,
        RATE_LIMIT_MODE: process.env.RATE_LIMIT_MODE,
        AUTH_TEST_MODE: process.env.AUTH_TEST_MODE,
        AUTH_REQUIRE_EMAIL_VERIFICATION: process.env.AUTH_REQUIRE_EMAIL_VERIFICATION,
        UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
        UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,

        UPLOAD_DIR: process.env.UPLOAD_DIR,
        FILE_STORAGE_ROOT: process.env.FILE_STORAGE_ROOT,
        FILE_MAX_SIZE_BYTES: process.env.FILE_MAX_SIZE_BYTES,
        FILE_ALLOWED_MIME: process.env.FILE_ALLOWED_MIME,

        STORAGE_PROVIDER: process.env.STORAGE_PROVIDER,
        S3_BUCKET: process.env.S3_BUCKET,
        S3_REGION: process.env.S3_REGION,
        S3_ENDPOINT: process.env.S3_ENDPOINT,
        S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
        S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,

        AV_WEBHOOK_SECRET: process.env.AV_WEBHOOK_SECRET,
        AV_SCAN_MODE: process.env.AV_SCAN_MODE,
        CLAMAV_HOST: process.env.CLAMAV_HOST,

        DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY,
        DATA_ENCRYPTION_KEY_PREVIOUS: process.env.DATA_ENCRYPTION_KEY_PREVIOUS,

        CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS,
        SMTP_HOST: process.env.SMTP_HOST,
        SMTP_PORT: process.env.SMTP_PORT,
        SMTP_USER: process.env.SMTP_USER,
        SMTP_PASS: process.env.SMTP_PASS,
        SMTP_FROM: process.env.SMTP_FROM,
        RESEND_API_KEY: process.env.RESEND_API_KEY,
        RESEND_FROM: process.env.RESEND_FROM,

        STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
        STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
        STRIPE_PRICE_ID_PRO: process.env.STRIPE_PRICE_ID_PRO,
        STRIPE_PRICE_ID_ENTERPRISE: process.env.STRIPE_PRICE_ID_ENTERPRISE,
        APP_URL: process.env.APP_URL,

        AI_RISK_PROVIDER: process.env.AI_RISK_PROVIDER,
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
        OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
        SOIL_PROVIDER: process.env.SOIL_PROVIDER,
        SOIL_BASE_URL: process.env.SOIL_BASE_URL,
        EC_AGRIFOOD_BASE_URL: process.env.EC_AGRIFOOD_BASE_URL,
        ALPHA_VANTAGE_API_KEY: process.env.ALPHA_VANTAGE_API_KEY,
        BARCHART_API_KEY: process.env.BARCHART_API_KEY,
        MARKET_NEWS_FEEDS: process.env.MARKET_NEWS_FEEDS,
        CADASTRE_OPENDATA_INDEX_URL: process.env.CADASTRE_OPENDATA_INDEX_URL,
        CADASTRE_WMS_URL: process.env.CADASTRE_WMS_URL,
        CADASTRE_WMS_LAYERS: process.env.CADASTRE_WMS_LAYERS,
        CADASTRE_WMS_PREMIUM_URL: process.env.CADASTRE_WMS_PREMIUM_URL,
        CADASTRE_PARCELS_URL: process.env.CADASTRE_PARCELS_URL,
        AI_BACKEND: process.env.AI_BACKEND,
        AI_BASE_URL: process.env.AI_BASE_URL,
        AI_API_KEY: process.env.AI_API_KEY,
        AI_MODEL: process.env.AI_MODEL,
        AI_EMBED_MODEL: process.env.AI_EMBED_MODEL,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
        AI_EMBED_BACKEND: process.env.AI_EMBED_BACKEND,
        AI_EMBED_BASE_URL: process.env.AI_EMBED_BASE_URL,
        AI_EMBED_API_KEY: process.env.AI_EMBED_API_KEY,
        VISION_BACKEND: process.env.VISION_BACKEND,
        VISION_MODEL_PATH: process.env.VISION_MODEL_PATH,
        VISION_LABELS_PATH: process.env.VISION_LABELS_PATH,
        AI_RISK_DAILY_QUOTA: process.env.AI_RISK_DAILY_QUOTA,
        AI_RISK_USER_RPM: process.env.AI_RISK_USER_RPM,
        AI_RISK_ENABLED: process.env.AI_RISK_ENABLED,
        AI_EVAL_LLM_JUDGE: process.env.AI_EVAL_LLM_JUDGE,
        AI_CACHE_TTL_SECONDS: process.env.AI_CACHE_TTL_SECONDS,
        AI_EMBED_CACHE_TTL_SECONDS: process.env.AI_EMBED_CACHE_TTL_SECONDS,
        AI_RATE_LIMIT_PER_MIN: process.env.AI_RATE_LIMIT_PER_MIN,
        AI_EVAL_AB_BACKEND: process.env.AI_EVAL_AB_BACKEND,
        AI_RISK_PLAN_REQUIRED: process.env.AI_RISK_PLAN_REQUIRED,
        AGRO_DATASTREAMS_ENABLED: process.env.AGRO_DATASTREAMS_ENABLED,
        GEE_PROJECT_ID: process.env.GEE_PROJECT_ID,
        GEE_SERVICE_ACCOUNT_KEY: process.env.GEE_SERVICE_ACCOUNT_KEY,

        AUDIT_STREAM_RETRY_ENABLED: process.env.AUDIT_STREAM_RETRY_ENABLED,
        AUDIT_STREAM_LEGACY_HEADERS: process.env.AUDIT_STREAM_LEGACY_HEADERS,
        PLATFORM_ADMIN_API_KEY: process.env.PLATFORM_ADMIN_API_KEY,
        PLATFORM_ADMIN_API_KEY_PREVIOUS: process.env.PLATFORM_ADMIN_API_KEY_PREVIOUS,
        PLATFORM_TENANT_SLUG: process.env.PLATFORM_TENANT_SLUG,
        PRIVACY_CONTACT_EMAIL: process.env.PRIVACY_CONTACT_EMAIL,
        NOTIFICATIONS_TZ: process.env.NOTIFICATIONS_TZ,
        VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
        VAPID_SUBJECT: process.env.VAPID_SUBJECT,

        NEXT_PUBLIC_NOTIFICATIONS_SSE: process.env.NEXT_PUBLIC_NOTIFICATIONS_SSE,
        NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
        NEXT_PUBLIC_MAPTILER_KEY: process.env.NEXT_PUBLIC_MAPTILER_KEY,
        NEXT_PUBLIC_MAP_BASEMAP_STYLE: process.env.NEXT_PUBLIC_MAP_BASEMAP_STYLE,
        NEXT_PUBLIC_PRIVACY_URL: process.env.NEXT_PUBLIC_PRIVACY_URL,
        NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
        NEXT_PUBLIC_SENTRY_RELEASE: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    },
    /**
     * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation.
     * This is especially useful for Docker builds.
     */
    skipValidation: !!process.env.SKIP_ENV_VALIDATION,
    /**
     * Makes it so that empty strings are treated as undefined.
     * `SOME_VAR: z.string()` and `SOME_VAR=''` will throw an error.
     */
    emptyStringAsUndefined: true,
});
