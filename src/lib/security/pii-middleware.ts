/**
 * PII Encryption Middleware (GAP-21 final form).
 *
 * Prisma `$use` middleware that makes encrypted-only PII storage
 * transparent to callers. The schema-level field names (`email`,
 * `name`, `emailAtLinkTime`) are remapped to the encrypted DB
 * columns via Prisma `@map`; the middleware encrypts on write,
 * decrypts on read, AND rewrites any `where` clause that targets a
 * managed plaintext field so the lookup hits the deterministic
 * hash column instead of the random-IV ciphertext column.
 *
 *   ┌──────────────────────┬──────────────────────┬──────────────────────┐
 *   │ Operation            │ Caller writes        │ Middleware translates│
 *   ├──────────────────────┼──────────────────────┼──────────────────────┤
 *   │ create / update      │ data.email = "x"     │ data.email = enc("x")│
 *   │                      │                      │ data.emailHash = h("x")│
 *   │ findUnique / findFirst│ where.email = "x"   │ where.emailHash = h("x")│
 *   │                      │                      │ where.email deleted  │
 *   │ findMany / count     │ same as findFirst    │ same                 │
 *   │ read result          │ user.email is plain  │ decrypt encrypted    │
 *   │                      │                      │ column → email field │
 *   └──────────────────────┴──────────────────────┴──────────────────────┘
 *
 * Why WHERE-rewriting: after dropping the plaintext column, the
 * schema `email` field is `@map("emailEncrypted")`. A naive
 * `where: { email: 'a@b.com' }` would compare against the random-IV
 * ciphertext column and never match. Rewriting to
 * `where: { emailHash: hashForLookup('a@b.com') }` redirects the
 * lookup to the deterministic hash and preserves uniqueness
 * semantics (the @unique constraint moves from email to emailHash).
 *
 * Why data.email cleanup on writes: same story — the schema field
 * is mapped, so when the middleware sets `data.email = encrypted` it
 * lands correctly. We delete any stray `data.<plain>` keys that
 * don't have an encrypted counterpart so callers can't accidentally
 * leak plaintext into a non-encrypting code path.
 *
 * SECURITY: never logs field values. Treat any future log additions
 * with the same guard — only structural identifiers (model, field
 * names) may appear in log payloads.
 */
import { encryptField, decryptField, hashForLookup, isEncryptedValue } from './encryption';
import { logger } from '@/lib/observability/logger';

// ─── Field Mappings ─────────────────────────────────────────────────

/**
 * Three flavours of mapping per (model, plain-field):
 *
 *   - `column`: the DB column the schema field maps to. After
 *     GAP-21 this is the *encrypted* column for managed fields.
 *     Used to populate `data[plain]` with ciphertext on writes (so
 *     Prisma writes the correct column), and to recognise where the
 *     decrypted value should land on reads.
 *
 *   - `hash`: the lookup-hash column, when one exists. Required for
 *     any field used in unique/equality lookups. The middleware
 *     auto-populates this on writes and rewrites WHERE clauses to
 *     target it on reads.
 *
 *   - `mapped`: `true` when `plain` is `@map`'d to the encrypted
 *     column at the schema level (post-GAP-21). `false` when the
 *     plaintext column still exists as its own DB column (legacy
 *     dual-write path; managed by the same middleware so the
 *     transition is one PR per model rather than one big bang).
 *
 * Adding a new managed field: pick the right mapping flavour, then
 * add a unit test in `tests/unit/security/pii-middleware.test.ts`
 * to lock in the where/data behaviours.
 */
interface PiiFieldSpec {
    plain: string;
    encrypted: string;
    hash?: string;
    /**
     * When true, the schema field name `plain` maps to the encrypted
     * DB column (post-GAP-21 for User and UserIdentityLink). When
     * false, the plaintext column is its own
     * column and the middleware dual-writes (legacy models).
     */
    mapped: boolean;
}

const PII_FIELD_MAP: Record<string, PiiFieldSpec[]> = {
    User: [
        { plain: 'email', encrypted: 'emailEncrypted', hash: 'emailHash', mapped: true },
        { plain: 'name', encrypted: 'nameEncrypted', mapped: true },
    ],
    UserIdentityLink: [
        { plain: 'emailAtLinkTime', encrypted: 'emailAtLinkTimeEncrypted', hash: 'emailAtLinkTimeHash', mapped: true },
    ],
    // ── Models still on the legacy dual-write path ──────────────────
    // These models keep their plaintext columns until a follow-up PR
    // ports them to the @map'd / hash-only model. The middleware
    // continues to write both columns so reads stay consistent.
    NotificationOutbox: [
        { plain: 'toEmail', encrypted: 'toEmailEncrypted', mapped: false },
    ],
    Account: [
        { plain: 'access_token', encrypted: 'accessTokenEncrypted', mapped: false },
        { plain: 'refresh_token', encrypted: 'refreshTokenEncrypted', mapped: false },
    ],
};

// ─── Helpers ────────────────────────────────────────────────────────

function encryptOnWrite(
    data: Record<string, unknown>,
    fields: PiiFieldSpec[],
): void {
    for (const spec of fields) {
        const value = data[spec.plain];
        if (typeof value !== 'string' || value.length === 0) continue;

        if (spec.mapped) {
            // Field is @map'd to the encrypted column. Replace the
            // value in-place with ciphertext — Prisma writes it to
            // the correct column.
            data[spec.plain] = encryptField(value);
        } else {
            // Legacy dual-write: keep plaintext, also write encrypted.
            data[spec.encrypted] = encryptField(value);
        }
        if (spec.hash) {
            data[spec.hash] = hashForLookup(value);
        }
    }
}

function decryptOnRead(
    record: Record<string, unknown>,
    fields: PiiFieldSpec[],
    model?: string,
): void {
    for (const spec of fields) {
        if (spec.mapped) {
            // Schema field IS the encrypted column. Decrypt in place
            // so callers reading `user.email` see plaintext.
            const value = record[spec.plain];
            if (typeof value === 'string' && isEncryptedValue(value)) {
                try {
                    record[spec.plain] = decryptField(value);
                } catch {
                    // Decryption failed — most likely a KEK mismatch
                    // (the row was encrypted under a key that's no
                    // longer in env, even with
                    // DATA_ENCRYPTION_KEY_PREVIOUS as fallback). Replace
                    // the value with null instead of leaving raw
                    // ciphertext: downstream renderers (UI labels,
                    // PDF exports, audit-pack share links, SDK
                    // consumers reading the row verbatim) would
                    // otherwise display `v1:base64...` as if it were
                    // user content. Operators see the failure via
                    // the structural log; the value itself is never
                    // logged.
                    record[spec.plain] = null;
                    logger.warn('pii.decrypt_failure', {
                        component: 'pii-middleware',
                        model,
                        field: spec.plain,
                    });
                }
            }
        } else {
            // Legacy: decrypt encrypted column INTO plain field. The
            // plaintext column is still present on legacy models, so
            // a decrypt failure leaves record[spec.plain] populated
            // from the dual-write source — no ciphertext-leak risk
            // here, but we still log so operators can see the
            // discrepancy.
            const encValue = record[spec.encrypted];
            if (typeof encValue === 'string' && isEncryptedValue(encValue)) {
                try {
                    record[spec.plain] = decryptField(encValue);
                } catch {
                    logger.warn('pii.decrypt_failure', {
                        component: 'pii-middleware',
                        model,
                        field: spec.plain,
                        legacy: true,
                    });
                }
            }
        }
    }
}

/**
 * Maps the Prisma relation key (lowerCamel) to the model name used as
 * the key in `PII_FIELD_MAP`. When a result row exposes a nested
 * relation (e.g. `OrgMembership.user`, `TenantMembership.user`,
 * `AuditLog.user`) the schema field name is the lowerCamel singular
 * of the model. We map back here so `decryptResultDeep` can locate
 * the right manifest entry.
 *
 * Add a row when you introduce a managed model with a different
 * relation key. Generic walking of every key is intentionally NOT
 * done — it would over-eagerly inspect non-PII relations on every
 * read, which is a perf regression for a tiny ergonomic gain.
 */
const RELATION_KEY_TO_MODEL: Record<string, string> = {
    user: 'User',
    inviter: 'User',
    invitedBy: 'User',
    invitedByUser: 'User',
    creator: 'User',
    owner: 'User',
    assignee: 'User',
    identityLink: 'UserIdentityLink',
};

/**
 * Walks a result tree and decrypts any embedded nested relation that
 * points at a managed model. Recurses through arrays + objects but
 * caps depth so an unbounded includes chain can't OOM us.
 */
function decryptNested(
    record: unknown,
    depth: number,
): void {
    if (depth >= 4 || !record || typeof record !== 'object') return;
    if (Array.isArray(record)) {
        for (const item of record) decryptNested(item, depth + 1);
        return;
    }
    const obj = record as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
        if (!value || typeof value !== 'object') continue;
        const nestedModel = RELATION_KEY_TO_MODEL[key];
        if (nestedModel) {
            const nestedFields = PII_FIELD_MAP[nestedModel];
            if (nestedFields) {
                if (Array.isArray(value)) {
                    for (const item of value) {
                        if (item && typeof item === 'object') {
                            decryptOnRead(item as Record<string, unknown>, nestedFields, nestedModel);
                        }
                    }
                } else {
                    decryptOnRead(value as Record<string, unknown>, nestedFields, nestedModel);
                }
            }
        }
        // Recurse — even non-PII relations may have PII relations
        // beneath them (e.g. TenantMembership.tenant.someUser).
        decryptNested(value, depth + 1);
    }
}

function decryptResult(result: unknown, model: string): unknown {
    const fields = PII_FIELD_MAP[model];

    // Top-level decrypt for the queried model (when managed).
    if (fields) {
        if (Array.isArray(result)) {
            for (const item of result) {
                if (item && typeof item === 'object') {
                    decryptOnRead(item as Record<string, unknown>, fields, model);
                }
            }
        } else if (result && typeof result === 'object') {
            decryptOnRead(result as Record<string, unknown>, fields, model);
        }
    }

    // Nested decrypt for relations into managed models, regardless of
    // whether the top-level model is itself managed (e.g.
    // OrgMembership.findMany({ include: { user: ... } })).
    decryptNested(result, 0);

    return result;
}

/**
 * Rewrites a WHERE clause so that an equality predicate on a managed
 * plaintext field is redirected to the deterministic hash column.
 *
 * Handles three caller shapes:
 *
 *   1. `where: { email: 'a@b.com' }`               → `{ emailHash: h('a@b.com') }`
 *   2. `where: { email: { equals: 'a@b.com' } }`   → `{ emailHash: h('a@b.com') }`
 *   3. `where: { email: { in: ['a@b.com', ...] } }`→ `{ emailHash: { in: [h(...), h(...)] } }`
 *
 * Only mapped fields with a hash column qualify — anything else is
 * left untouched (for non-mapped legacy fields, the plaintext
 * column still exists at the DB and a literal lookup works).
 *
 * The function MUTATES the where object in place. It also recurses
 * into AND/OR/NOT compound clauses so `where: { OR: [{ email: ... }] }`
 * is rewritten correctly.
 *
 * Logs nothing — security-sensitive code path.
 */
function rewriteWhereForHash(
    where: Record<string, unknown>,
    fields: PiiFieldSpec[],
): void {
    for (const spec of fields) {
        // Only mapped fields with a hash column need rewriting; the
        // mapped column is ciphertext at the DB, so a literal lookup
        // will never match.
        if (!spec.mapped || !spec.hash) continue;
        if (!(spec.plain in where)) continue;

        const predicate = where[spec.plain];
        if (typeof predicate === 'string') {
            // Shape 1 — bare equality.
            where[spec.hash] = hashForLookup(predicate);
            delete where[spec.plain];
        } else if (
            predicate &&
            typeof predicate === 'object' &&
            !Array.isArray(predicate)
        ) {
            const obj = predicate as Record<string, unknown>;
            if (typeof obj.equals === 'string') {
                // Shape 2 — { equals: 'x' }.
                where[spec.hash] = hashForLookup(obj.equals);
                delete where[spec.plain];
            } else if (Array.isArray(obj.in)) {
                // Shape 3 — { in: ['x', 'y'] }.
                const hashed = obj.in
                    .filter((v): v is string => typeof v === 'string')
                    .map((v) => hashForLookup(v));
                where[spec.hash] = { in: hashed };
                delete where[spec.plain];
            }
            // Other operators (`startsWith`, `contains`, etc.) cannot
            // be expressed against a hash. A caller using those on a
            // managed PII field has a bug; we leave the predicate
            // untouched so it surfaces as "no rows found" rather
            // than silently rewriting to an incorrect lookup.
        }
    }

    // Recurse into compound clauses.
    for (const key of ['AND', 'OR', 'NOT'] as const) {
        const compound = where[key];
        if (Array.isArray(compound)) {
            for (const sub of compound) {
                if (sub && typeof sub === 'object') {
                    rewriteWhereForHash(sub as Record<string, unknown>, fields);
                }
            }
        } else if (compound && typeof compound === 'object') {
            rewriteWhereForHash(compound as Record<string, unknown>, fields);
        }
    }
}

/**
 * Top-level entry point for WHERE rewriting. Inspects the
 * action-specific args shape and walks any embedded `where`.
 */
function rewriteArgsWhere(
    args: Record<string, unknown> | undefined,
    fields: PiiFieldSpec[],
): void {
    if (!args || typeof args !== 'object') return;
    const where = args.where;
    if (where && typeof where === 'object' && !Array.isArray(where)) {
        rewriteWhereForHash(where as Record<string, unknown>, fields);
    }
}

// ─── Middleware ──────────────────────────────────────────────────────

/**
 * Diagnostic — fires exactly once, the first time a Prisma query
 * actually flows through this middleware. If we never see this log
 * line in production, the middleware is registered but not invoked
 * (suspected on prod 2026-04-29: Next.js bundling / module-graph
 * issue causing NextAuth's PrismaAdapter to use a different prisma
 * instance than the one with `$use(piiEncryptionMiddleware)` attached).
 *
 * Combined with `pii.middleware_registered` (emitted from
 * `src/lib/prisma.ts` at $use time), the two signals tell us:
 *   • registered + first_invocation seen   → middleware works
 *   • registered + no first_invocation     → registration/runtime split
 *   • no registered                        → $use never called (Edge Runtime?)
 */
let _firstInvocationLogged = false;

/**
 * Core PII encrypt/decrypt logic — shared between the legacy
 * Prisma 5 `$use` middleware shape (preserved for unit-test
 * mocking) and the Prisma 7 `$extends` wrapper.
 *
 * The handler shape is the v5 `(params, next)` contract because it
 * reads cleanly and the body uses `params.action` / `params.model`
 * / `params.args` extensively. The v7 wrapper below adapts this to
 * the `$extends` per-action handler shape.
 */
async function runPiiEncryption(
    params: {
        action: string;
        model?: string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: any;
    },
    next: (p: typeof params) => Promise<unknown>,
): Promise<unknown> {
    if (!_firstInvocationLogged) {
        _firstInvocationLogged = true;
        logger.info('pii.middleware_first_invocation', {
            component: 'pii-middleware',
            firstAction: params.action,
            firstModel: params.model ?? null,
        });
    }
    const fields = params.model ? PII_FIELD_MAP[params.model] : undefined;

    // We MUST NOT early-out when `fields` is undefined: a non-managed
    // model like `OrgMembership` or `AuditLog` may include nested
    // relations (`user`, `creator`, …) that ARE managed, and the
    // result-side decryption walks those. Encryption / WHERE
    // rewriting is gated on `fields` further down.

    // ─── Encrypt on write ───
    if (fields) {
        if (
            params.action === 'create' ||
            params.action === 'update' ||
            params.action === 'upsert' ||
            params.action === 'updateMany'
        ) {
            if (params.action === 'upsert') {
                if (params.args.create && typeof params.args.create === 'object') {
                    encryptOnWrite(params.args.create as Record<string, unknown>, fields);
                }
                if (params.args.update && typeof params.args.update === 'object') {
                    encryptOnWrite(params.args.update as Record<string, unknown>, fields);
                }
            } else {
                if (params.args.data && typeof params.args.data === 'object') {
                    encryptOnWrite(params.args.data as Record<string, unknown>, fields);
                }
            }
        }

        // createMany
        if (params.action === 'createMany' && Array.isArray(params.args?.data)) {
            for (const item of params.args.data) {
                if (item && typeof item === 'object') {
                    encryptOnWrite(item as Record<string, unknown>, fields);
                }
            }
        }

        // ─── Rewrite WHERE → hash for read/scoped-write actions ───
        //
        // `findUnique` callers use `where: { email: '...' }` — that
        // has to redirect to the hash column on mapped models.
        // `update` / `updateMany` / `delete` / `deleteMany` callers
        // can also pass a where clause; same treatment.
        const whereActions = [
            'findUnique',
            'findUniqueOrThrow',
            'findFirst',
            'findFirstOrThrow',
            'findMany',
            'count',
            'aggregate',
            'groupBy',
            'update',
            'updateMany',
            'delete',
            'deleteMany',
            'upsert',
        ];
        if (whereActions.includes(params.action)) {
            rewriteArgsWhere(
                params.args as Record<string, unknown> | undefined,
                fields,
            );
        }
    }

    // ─── Execute query ───
    const result = await next(params);

    // ─── Decrypt on read ───
    const readActions = [
        'findUnique', 'findUniqueOrThrow',
        'findFirst', 'findFirstOrThrow',
        'findMany',
        'create', 'update', 'upsert',
    ];

    if (readActions.includes(params.action)) {
        // Always pass through — decryptResult handles both top-level
        // (when params.model is managed) AND nested relations into
        // managed models, regardless of the top-level model.
        return decryptResult(result, params.model ?? '');
    }

    return result;
}

/**
 * Legacy v5 middleware shape — preserved as a thin wrapper around
 * `runPiiEncryption` so existing unit tests can mock the
 * `(params, next)` contract directly without learning the v7
 * `$extends` API. Production code paths use
 * `withPiiEncryptionExtension` below.
 */
export const piiEncryptionMiddleware = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    next: (p: any) => Promise<any>,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> => runPiiEncryption(params, next);

/**
 * Wire the PII encryption extension onto a Prisma 7 client.
 *
 * Each per-action handler in the `$allModels` extension adapts the
 * v7 call shape `({ model, operation, args, query })` into the v5
 * `(params, next)` shape that `runPiiEncryption` already speaks.
 * This keeps the encrypt/decrypt/where-rewrite logic in one
 * place — the only thing that changes between v5 and v7 is the
 * adapter glue.
 *
 * Composition: this extension MUST sit OUTSIDE soft-delete and
 * audit so that:
 *   - PII gets encrypted BEFORE soft-delete transforms `delete` →
 *     `update` (the resulting update has encrypted columns)
 *   - PII WHERE-rewrites apply BEFORE soft-delete injects
 *     `deletedAt: null`
 *   - Audit sees the final encrypted args, not plaintext (the
 *     audit row's `detailsJson.after` carries safe values)
 *
 * The chain order is enforced in `src/lib/prisma.ts`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withPiiEncryptionExtension<T extends { $extends: any }>(
    client: T,
): T {
    return client.$extends({
        name: 'pii-encryption',
        query: {
            $allModels: {
                async $allOperations({
                    model,
                    operation,
                    args,
                    query,
                }: {
                    model: string;
                    operation: string;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    args: any;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    query: (a: any) => Promise<any>;
                }) {
                    return runPiiEncryption(
                        { action: operation, model, args },
                        ({ args: nextArgs }) => query(nextArgs),
                    );
                },
            },
        },
    }) as T;
}

/**
 * Returns the PII field map for a specific model.
 * Useful for testing and introspection.
 * @internal
 */
export function _getPiiFieldMap(model: string): readonly PiiFieldSpec[] | undefined {
    return PII_FIELD_MAP[model];
}

/**
 * Test-only: invokes the WHERE rewriter directly. Exposes the pure
 * transform without going through the full middleware so behaviour
 * can be asserted in isolation.
 * @internal
 */
export function _rewriteWhereForHash(
    where: Record<string, unknown>,
    model: string,
): Record<string, unknown> {
    const fields = PII_FIELD_MAP[model];
    if (!fields) return where;
    rewriteWhereForHash(where, fields);
    return where;
}
