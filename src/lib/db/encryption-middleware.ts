/**
 * Epic B.1 + B.2 — Transparent field-level encryption middleware.
 *
 * Installs a Prisma `$use` hook that encrypts manifest fields on
 * write and decrypts them on read. The key used for each operation
 * is resolved at hook entry:
 *
 *   ─ **B.2 path (default):** when `getAuditContext()` carries a
 *     `tenantId` from an authenticated request, the middleware calls
 *     `getTenantKeyManager().getTenantDek(tenantId)` to get the raw
 *     per-tenant DEK and uses `encryptWithKey` / `decryptWithKey`.
 *     Ciphertexts carry the `v2:` envelope prefix.
 *
 *   ─ **B.1 fallback:** when there's no tenant context (seed / job /
 *     system bypass paths, webhook ingest pre-identification, auth
 *     discovery), the middleware falls back to `encryptField` /
 *     `decryptField` under the global KEK. Ciphertexts carry the
 *     `v1:` envelope prefix. Read mixed-state remains safe because
 *     the decrypt path dispatches per-value on the `v1:` / `v2:`
 *     prefix.
 *
 * ## Mixed-state rollout
 *
 * Rows written before B.2 rollout are `v1:`. Rows written after are
 * `v2:`. The read path handles both — `getCiphertextVersion()` picks
 * the right decrypt. A big-bang re-encrypt is unnecessary; rows
 * slowly migrate as they're updated, and the backfill script can
 * force it explicitly later.
 *
 * ## Cross-tenant isolation
 *
 * Each tenant's DEK is independent random bytes wrapped under the
 * global KEK. Decrypting tenant A's `v2:` ciphertext with tenant B's
 * DEK produces an AES-GCM auth-tag failure — the middleware logs the
 * warn, returns the raw ciphertext, and continues. The caller sees
 * undecrypted material (not a decrypt-crash); ops sees the incident
 * via the `decrypt_failed` log line.
 *
 * ## Recursion guard
 *
 * Resolving a tenant's DEK issues `prisma.tenant.findUnique`, which
 * re-enters this middleware. `Tenant` is not in the encrypted-fields
 * manifest, so the inner hook's fan-out finds nothing to process —
 * but we also skip DEK resolution entirely when `params.model ===
 * 'Tenant'` to avoid any risk of infinite recursion.
 *
 * ## Idempotency
 *
 * Every ciphertext carries a `v1:` or `v2:` prefix. Writes skip
 * values that already match either prefix (`isEncryptedValue()`),
 * so nested-write fan-out, test doubles, and concurrent writes
 * never produce double ciphertext.
 *
 * ## Null / empty
 *
 * `null` / `undefined` / `''` pass through unchanged — encrypting
 * an empty string wastes bytes with no security gain.
 */

// PrismaClient import removed — Prisma 7 extensions accept any
// client-with-$extends instead of a typed PrismaClient instance.
import {
    encryptField,
    decryptField,
    encryptWithKey,
    decryptWithKeyOrPrevious,
    isEncryptedValue,
    getCiphertextVersion,
} from '@/lib/security/encryption';
import {
    getEncryptedFields,
    ALL_ENCRYPTED_FIELD_NAMES,
    nodeHasAnyEncryptedFieldKey,
} from '@/lib/security/encrypted-fields';
import { Prisma } from '@prisma/client';
import { getAuditContext } from '@/lib/audit-context';
import { logger } from '@/lib/observability/logger';
// `import * as` (rather than a top-level named import) keeps the
// circular-import escape hatch — `tenant-key-manager` imports
// `@/lib/prisma`, which composes this module — while still exposing
// the symbols at call time. The previous lazy `require('@/lib/...')`
// was invisibly broken by Turbopack's production minifier (resolved
// to `undefined`, surfacing as `"i is not a function"` runtime
// errors). Same pattern as `db/rls-middleware.ts::prismaModule`.
import * as tenantKeyManager from '@/lib/security/tenant-key-manager';

// ─── Action buckets ───────────────────────────────────────────────────

const WRITE_ACTIONS: ReadonlySet<string> = new Set([
    'create',
    'createMany',
    'createManyAndReturn',
    'update',
    'updateMany',
    'upsert',
]);

const RESULT_DECRYPT_ACTIONS: ReadonlySet<string> = new Set([
    'findFirst',
    'findUnique',
    'findFirstOrThrow',
    'findUniqueOrThrow',
    'findMany',
    'create',
    'update',
    'upsert',
    'createMany',
    'createManyAndReturn',
]);

/**
 * Audit-context `source` values that should fall back to the global
 * KEK (v1) instead of the tenant DEK (v2). These code paths don't
 * speak on behalf of a tenant — they're cross-tenant by design
 * (seeds populate globals, sweep jobs iterate all tenants, system
 * events are infrastructure), and making them write v2 under one
 * tenant's DEK would break their multi-tenant semantics.
 */
const BYPASS_SOURCES: ReadonlySet<string> = new Set([
    'seed',
    'job',
    'system',
]);

// ─── DEK resolution (Epic B.2) ────────────────────────────────────────

/**
 * A resolved tenant-DEK pair. `primary` is the current encryption
 * key (used for new writes and the first decrypt attempt on every
 * v2 ciphertext). `previous` is non-null only while a per-tenant
 * DEK rotation is mid-flight (`Tenant.previousEncryptedDek` is
 * populated) — used as the fallback inside
 * `decryptWithKeyOrPrevious` so reads of rows still under the old
 * DEK keep working until the sweep rewrites them.
 */
interface TenantDekPair {
    primary: Buffer | null;
    previous: Buffer | null;
}

const NO_DEK_PAIR: TenantDekPair = { primary: null, previous: null };

/**
 * Models that always encrypt under the GLOBAL KEK, never a per-tenant DEK.
 *
 * `Tenant` is here for the obvious reason — its own row holds the wrapped DEK,
 * so it cannot be encrypted with it.
 *
 * `Company` (promotions #12) is here for a subtler one. It is a GLOBAL
 * catalogue with no tenantId, but it is WRITTEN by platform support operating
 * inside the designated platform tenant — so `ctx.tenantId` is set, and without
 * this entry the middleware would happily encrypt global supplier contact
 * details under that one tenant's DEK. That would bind global data to a
 * tenant's key: the lead-digest job could only decrypt while running in that
 * tenant's context, and changing `PLATFORM_TENANT_SLUG` (or rotating that
 * tenant's DEK independently) would orphan every supplier's contact address.
 *
 * `ExchangeMessage` (#1222) is here for a THIRD reason, and it is the one worth
 * reading before adding a fourth entry. It is not a global catalogue — it is a
 * TWO-PARTY row. The inquiring farm and the listing owner both read every
 * message in the thread, and `listThreadMessages` runs in the VIEWING party's
 * tenant context. A row encrypted under either party's DEK is therefore
 * unreadable by the other, which is not a degradation but a break: measured on
 * production, both messages on the only live thread were written by one tenant,
 * so the recipient could read neither and saw `v2:…` where the text should be.
 *
 * There is no per-tenant key that works here. Letting party B decrypt party A's
 * message would mean handing B party A's DEK — which would expose ALL of A's
 * v2 data, not one message. So the global KEK is the only key both sides share,
 * and `ExchangeMessage` has no `tenantId` column (the schema says so in terms:
 * the idempotency key is "scoped to `senderTenantId` rather than a `tenantId`
 * the row does not have"), so it satisfies the rule below on its face as well.
 *
 * The rule turns on HOW MANY TENANTS MUST READ THE ROW, not on whether a
 * `tenantId` column exists — and the difference is not pedantic, because
 * `PromotionLead` is a live counter-example to the simpler version. It has no
 * `tenantId` and encrypted fields, yet is DELIBERATELY left on a per-tenant
 * DEK: exactly one tenant reads it (the farm that wrote the enquiry), and the
 * future lead-digest job is expected to resolve each lead's tenant context to
 * decrypt. CLAUDE.md and `prisma/schema/promotions.prisma` both record that
 * posture. A guard written to the simpler rule flagged it, and adding it here
 * to go green would have reversed a documented decision.
 *
 * So: a model belongs here when no single tenant's key can serve its readers —
 * because it has no tenant (a global catalogue), or because more than one
 * tenant must read the same row. Tenant-scoped models must NOT be added; they
 * would lose per-tenant key isolation, and for them that isolation is
 * achievable. The exception list lives in
 * `tests/guards/global-kek-models-covers-tenantless.test.ts`, which enforces
 * both directions.
 */
// Exported so the v2-repair sweep and its guard read THIS set rather than
// keeping a copy. Two lists of which models are global-KEK is how the two
// answers drift, and the drift would be silent: a model promoted here but
// absent from the repair's view keeps its misplaced v2 rows forever.
export const GLOBAL_KEK_MODELS: ReadonlySet<string> = new Set([
    'Tenant',
    'Company',
    'ExchangeMessage',
    // #1222. No `tenantId`, and every reader is a platform admin rather than a
    // tenant — so by the rule above, no single tenant's key can serve them.
    // Production already holds a `v1:` row on `FeatureFlag.description`,
    // written by a platform admin with no tenant context to resolve a DEK
    // from, so the KEK is not a change of posture here; it is what the data is
    // already under. Declaring it keeps that row readable through the fan-out
    // narrowing, which stops the middleware decrypting undeclared models.
    'FeatureFlag',
    // P5.1 (#1553). Tenantless and encrypted, so the rule above applies — and
    // the reason is the same one FeatureFlag gives: every reader is a platform
    // admin, reached through an API-key surface with no tenant context to
    // resolve a DEK from.
    //
    // `ContentReport` additionally has a NON-platform reader — the reporter,
    // through the `content_report_reporter_read` policy arm — and that reader
    // reinforces rather than weakens the case. A reporter reads their own row
    // in a PERSON context (`runInUserContext`), which sets `app.user_id` and
    // deliberately NO `app.tenant_id`, so there is no tenant key there either.
    'ContentReport',
    'ModerationAction',
    'StatementOfReasons',
]);

/**
 * Resolve the per-tenant DEK pair for the current operation, or the
 * `{ null, null }` sentinel when the middleware should fall back to
 * the global KEK.
 *
 * Returns the empty pair when any of:
 *   - `model === 'Tenant'` — recursion guard. `getTenantDek` reads
 *     the `Tenant` row itself, which re-enters this hook; we must
 *     NOT try to resolve a DEK for a Tenant query.
 *   - no audit context (raw `prisma` calls outside the tenant wrapper)
 *   - `source` is one of the known bypass markers
 *   - the manager throws (missing tenant / DB error)
 *
 * In every empty-pair case, the middleware uses `encryptField` /
 * `decryptField` under the global KEK — same behaviour as Epic B.1.
 *
 * The `previous` slot is independently optional. The primary may
 * resolve while the previous is null (steady state, no rotation in
 * flight). Both null is the global-KEK fallback. Primary null +
 * previous non-null is impossible by construction.
 */
async function resolveTenantDekPair(
    model: string | undefined,
): Promise<TenantDekPair> {
    if (model && GLOBAL_KEK_MODELS.has(model)) return NO_DEK_PAIR;

    const ctx = getAuditContext();
    const tenantId = ctx?.tenantId;
    if (!tenantId) return NO_DEK_PAIR;
    if (ctx?.source && BYPASS_SOURCES.has(ctx.source)) return NO_DEK_PAIR;

    // Read through the namespace import. The static `import *` at the
    // top of this file is the canonical fix for the circular cycle
    // (`tenant-key-manager` → `@/lib/prisma` → `withEncryptionExtension`)
    // that doesn't trip Turbopack's production minifier — see the
    // import comment block.
    const { getTenantDek, getTenantPreviousDek } = tenantKeyManager;

    let primary: Buffer | null;
    try {
        primary = await getTenantDek(tenantId);
    } catch (err) {
        logger.warn('encryption-middleware.dek_resolve_failed', {
            component: 'encryption-middleware',
            tenantId,
            reason: err instanceof Error ? err.message : 'unknown',
        });
        return NO_DEK_PAIR;
    }

    // The previous-DEK lookup is cheap in steady state (negative TTL
    // cache short-circuits the DB) and bounded during rotation
    // (cache hit after the first call). A failure here is benign —
    // we proceed with primary-only and accept that mid-rotation
    // reads of stale rows fail in this process until the sweep
    // catches up.
    let previous: Buffer | null = null;
    try {
        previous = await getTenantPreviousDek(tenantId);
    } catch (err) {
        logger.warn('encryption-middleware.previous_dek_resolve_failed', {
            component: 'encryption-middleware',
            tenantId,
            reason: err instanceof Error ? err.message : 'unknown',
        });
    }

    return { primary, previous };
}

// ─── Encrypt traversal (write path) ──────────────────────────────────

/**
 * Encrypt a single value with either the tenant DEK (v2) or the
 * global KEK (v1). `null` dek → v1 fallback. All other safety
 * checks (null/empty/already-encrypted) are the caller's
 * responsibility.
 */
function encryptValue(plaintext: string, dek: Buffer | null): string {
    if (dek) return encryptWithKey(dek, plaintext);
    return encryptField(plaintext);
}

/**
 * Encrypt manifest fields on a single data node. Mutates in place.
 * Uses `dek` when present (B.2), else falls back to the global KEK.
 */
function encryptDataNode(
    data: Record<string, unknown>,
    modelName: string,
    dek: Buffer | null,
): void {
    const fields = getEncryptedFields(modelName);
    if (!fields) return;
    for (const field of fields) {
        const value = data[field];
        if (value === null || value === undefined) continue;
        if (typeof value !== 'string') continue;
        if (value.length === 0) continue;
        if (isEncryptedValue(value)) continue;
        data[field] = encryptValue(value, dek);
    }
}

/**
 * Fan-out encrypt: applied when a nested node's target model is
 * structurally unknown. Walks the node's OWN keys once and encrypts
 * any key that matches an encrypted field name anywhere in the
 * manifest.
 */
function encryptDataNodeAllModels(
    data: Record<string, unknown>,
    dek: Buffer | null,
): void {
    if (!nodeHasAnyEncryptedFieldKey(data)) return;
    for (const key of Object.keys(data)) {
        if (!ALL_ENCRYPTED_FIELD_NAMES.has(key)) continue;
        const value = data[key];
        if (value === null || value === undefined) continue;
        if (typeof value !== 'string') continue;
        if (value.length === 0) continue;
        if (isEncryptedValue(value)) continue;
        data[key] = encryptValue(value, dek);
    }
}

/**
 * Relation map: `"ParentModel.relationField" -> "TargetModel"`.
 *
 * Nested writes (`{ promotion: { create: {...} } }`) don't name their target
 * model anywhere in the payload, which is why the descent used to fall back to
 * the `'*'` fan-out. But the target IS determined by the parent model plus the
 * relation field name, and Prisma's DMMF knows both — so it never needed to be
 * unknown.
 *
 * Built lazily and once: DMMF access is cheap but not free, and this module is
 * on the hot path for every write.
 */
let relationTargets: Map<string, string> | null = null;

function relationTargetFor(parentModel: string, field: string): string | undefined {
    if (parentModel === '*') return undefined;
    if (!relationTargets) {
        relationTargets = new Map();
        try {
            for (const model of Prisma?.dmmf?.datamodel?.models ?? []) {
                for (const f of model.fields ?? []) {
                    if (f.kind === 'object' && typeof f.type === 'string') {
                        relationTargets.set(`${model.name}.${f.name}`, f.type);
                    }
                }
            }
        } catch {
            // DMMF unavailable (an unusual runtime) — every lookup misses and
            // the caller falls back to the previous '*' behaviour.
        }
    }
    return relationTargets.get(`${parentModel}.${field}`);
}

/**
 * Walk a Prisma write payload and encrypt every manifest field.
 *
 * `modelName === '*'` triggers fan-out across all manifest models — now only
 * as a LAST RESORT, when the nested target cannot be resolved from the schema.
 * The fan-out is the dangerous branch: it matches field NAMES across the whole
 * manifest and cannot tell models apart, so a generic name like `message`
 * (shared by Notification / ExchangeInquiry / InsuranceLead) would be
 * encrypted on every model carrying it. Resolving the target model retires
 * that whole class for nested writes.
 */
function walkWriteArgument(
    payload: unknown,
    modelName: string,
    dek: Buffer | null,
): void {
    if (payload === null || payload === undefined) return;
    if (Array.isArray(payload)) {
        for (const item of payload) walkWriteArgument(item, modelName, dek);
        return;
    }
    if (typeof payload !== 'object') return;

    const node = payload as Record<string, unknown>;

    // 1. Encrypt fields on this node (direct or fan-out).
    if (modelName === '*') {
        encryptDataNodeAllModels(node, dek);
    } else {
        encryptDataNode(node, modelName, dek);
    }

    // 2. Descend into nested-writes shapes. The target model is resolved from
    //    (parent model, relation field) via the schema; '*' is the fallback
    //    only when that lookup misses.
    for (const [key, value] of Object.entries(node)) {
        if (!value || typeof value !== 'object') continue;
        const nested = value as Record<string, unknown>;
        const target = relationTargetFor(modelName, key) ?? '*';
        if ('create' in nested) walkWriteArgument(nested.create, target, dek);
        if ('update' in nested) walkWriteArgument(nested.update, target, dek);
        if ('upsert' in nested) {
            const u = nested.upsert as Record<string, unknown> | undefined;
            if (u?.create) walkWriteArgument(u.create, target, dek);
            if (u?.update) walkWriteArgument(u.update, target, dek);
        }
        if ('connectOrCreate' in nested) {
            const coc = nested.connectOrCreate as
                | Record<string, unknown>
                | undefined;
            if (coc?.create) walkWriteArgument(coc.create, target, dek);
        }
        if ('createMany' in nested) {
            const cm = nested.createMany as Record<string, unknown> | undefined;
            if (cm?.data) walkWriteArgument(cm.data, target, dek);
        }
    }
}

// ─── Decrypt traversal (read path) ───────────────────────────────────

/**
 * Decrypt a single value based on its envelope version. v1 → global
 * KEK via `decryptField` (which has its own dual-KEK fallback for
 * master-key rotation). v2 → primary tenant DEK first, falling back
 * to the previous DEK on AES-GCM auth failure. If the ciphertext is
 * v2 but no primary DEK is available (cross-tenant bypass read),
 * the caller is expected to leave the value untouched and log a
 * warning — this function throws in that case so the caller can
 * distinguish "expected pass-through" from "real decrypt failure".
 */
function decryptValue(ciphertext: string, deks: TenantDekPair): string {
    const version = getCiphertextVersion(ciphertext);
    if (version === 'v1') {
        return decryptField(ciphertext);
    }
    if (version === 'v2') {
        if (!deks.primary) {
            throw new Error(
                'encryption-middleware: v2 ciphertext encountered but no tenant DEK is resolvable',
            );
        }
        // Steady state: deks.previous is null and this is a single
        // primary decrypt attempt with the same shape as before.
        // Mid-rotation: previous is non-null and the helper retries
        // under it on AES-GCM auth failure.
        return decryptWithKeyOrPrevious(deks.primary, deks.previous, ciphertext);
    }
    // Shouldn't happen — caller gates on isEncryptedValue.
    throw new Error('encryption-middleware: unknown ciphertext envelope');
}

function decryptResultNode(
    node: Record<string, unknown>,
    modelName: string,
    deks: TenantDekPair,
): void {
    const fields = getEncryptedFields(modelName);
    if (!fields) return;
    for (const field of fields) {
        const value = node[field];
        if (value === null || value === undefined) continue;
        if (typeof value !== 'string') continue;
        if (value.length === 0) continue;
        if (!isEncryptedValue(value)) continue;
        try {
            node[field] = decryptValue(value, deks);
        } catch (err) {
            // Never throw on read. A malformed row or a cross-tenant
            // bypass read that can't resolve the right DEK surfaces
            // as a warn + ciphertext pass-through, not a 500.
            logger.warn('encryption-middleware.decrypt_failed', {
                component: 'encryption-middleware',
                model: modelName,
                field,
                version: getCiphertextVersion(value),
                reason: err instanceof Error ? err.message : 'unknown',
            });
        }
    }
}

function decryptResultNodeAllModels(
    node: Record<string, unknown>,
    deks: TenantDekPair,
): void {
    for (const key of Object.keys(node)) {
        if (!ALL_ENCRYPTED_FIELD_NAMES.has(key)) continue;
        const value = node[key];
        if (value === null || value === undefined) continue;
        if (typeof value !== 'string') continue;
        if (value.length === 0) continue;
        if (!isEncryptedValue(value)) continue;
        try {
            node[key] = decryptValue(value, deks);
        } catch (err) {
            logger.warn('encryption-middleware.decrypt_failed', {
                component: 'encryption-middleware',
                model: '*',
                field: key,
                version: getCiphertextVersion(value),
                reason: err instanceof Error ? err.message : 'unknown',
            });
        }
    }
}

/**
 * Walk a Prisma result tree and decrypt every manifest field we
 * find. Handles single objects, arrays, and included relations.
 *
 * Accepts `null` as a shorthand for "no DEKs available" — same
 * semantics as `{ primary: null, previous: null }` (callers that
 * passed plain `null` before the dual-DEK refactor still work).
 */
function walkReadResult(
    result: unknown,
    modelName: string,
    deks: TenantDekPair | null,
): void {
    const pair = deks ?? NO_DEK_PAIR;
    if (result === null || result === undefined) return;
    if (Array.isArray(result)) {
        for (const item of result) walkReadResult(item, modelName, pair);
        return;
    }
    if (typeof result !== 'object') return;

    const node = result as Record<string, unknown>;

    if (modelName === '*') {
        // Fast path: if the node has zero keys matching ANY manifest
        // field name, we can skip the per-key iteration AND the per-
        // field type/prefix checks.
        if (nodeHasAnyEncryptedFieldKey(node)) {
            decryptResultNodeAllModels(node, pair);
        }
    } else {
        decryptResultNode(node, modelName, pair);
    }

    // Walk nested object / array values — might be included relations.
    for (const [key, value] of Object.entries(node)) {
        if (value === null || value === undefined) continue;
        if (typeof value !== 'object') continue;
        if (
            modelName !== '*' &&
            getEncryptedFields(modelName)?.includes(key)
        ) {
            continue;
        }
        walkReadResult(value, '*', pair);
    }
}

// ─── Middleware registration ─────────────────────────────────────────

/**
 * @deprecated v5 mutating shape — Prisma 7 removed `$use`. Use
 * `withEncryptionExtension(client)` instead, which returns a new
 * extended client. This stub remains so existing test files that
 * import the legacy name continue to compile.
 *
 * Production wiring is in `runInTenantContext` (per-transaction);
 * tests that called this on the singleton to test direct prisma
 * calls need to migrate to `withEncryptionExtension` and rebind
 * their `prisma` reference. FIXME — remove once migrated.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerEncryptionMiddleware(_client: any): void {
    /* no-op — see docstring */
}

/**
 * Wire the field-level encryption extension onto a Prisma 7 client.
 *
 * Prisma 7 removed `$use`; the same per-action logic now ships as
 * a `$extends({ query })` extension. The handler shape changed from
 * `(params, next)` to `({ model, operation, args, query })`; we
 * adapt the call site and otherwise preserve the encrypt-on-write /
 * decrypt-on-read body byte-for-byte.
 *
 * Idempotency: the original `$use` form had a module-level
 * `installed` flag to prevent double-registration. Extensions don't
 * mutate the client; calling this twice would just produce two
 * stacked extensions. Callers (today: `runInTenantContext` in
 * `rls-middleware.ts`) wire it exactly once on the inner
 * transactional client.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withEncryptionExtension<T extends { $extends: any }>(
    client: T,
): T {
    return client.$extends({
        name: 'field-encryption',
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
                    const isWrite = WRITE_ACTIONS.has(operation);
                    const isRead = RESULT_DECRYPT_ACTIONS.has(operation);

                    // Pre-resolve the DEK pair once for the whole
                    // operation. Cache hit after the first lookup per
                    // tenant in this process for the primary; the
                    // previous slot is null in steady state and only
                    // populated during an in-flight rotation.
                    const deks: TenantDekPair =
                        isWrite || isRead
                            ? await resolveTenantDekPair(model)
                            : NO_DEK_PAIR;

                    // ── Write path ──
                    if (isWrite) {
                        // #1222: the TOP-LEVEL model of an operation is always
                        // KNOWN, so sending a non-manifest one to `'*'` used
                        // the fan-out as a stand-in for "not in the manifest"
                        // — and the fan-out matches field NAMES, so it
                        // encrypted 18 (model, field) pairs nobody declared.
                        // `ExchangeListing.description` was encrypted because
                        // `Task`, `AccessReview` and `CostEntry` each declare a
                        // `description`.
                        //
                        // Passing the real model narrows it with no new
                        // machinery: `encryptDataNode` looks the model up in
                        // the manifest and returns early when it is absent, so
                        // an undeclared field is simply not encrypted.
                        //
                        // Nested writes get BETTER, not worse. Step 2 of
                        // `walkWriteArgument` resolves a nested target from
                        // (parent model, relation field) via the schema and
                        // falls back to `'*'` only when that lookup misses —
                        // and that resolution bails on a `'*'` parent. So a
                        // real parent name means nested manifest models are
                        // now targeted per-model instead of by name collision.
                        // `'*'` survives for its documented purpose alone: a
                        // node whose model is structurally unknowable.
                        const targetModel = model;

                        // Writes always use the primary DEK (or fall
                        // back to global KEK when null). The previous
                        // slot is irrelevant for writes — it exists
                        // solely so reads of stale rows can find
                        // their key during a rotation.
                        if (args?.data) {
                            walkWriteArgument(
                                args.data,
                                targetModel,
                                deks.primary,
                            );
                        }
                        if (operation === 'upsert') {
                            if (args?.create) {
                                walkWriteArgument(
                                    args.create,
                                    targetModel,
                                    deks.primary,
                                );
                            }
                            if (args?.update) {
                                walkWriteArgument(
                                    args.update,
                                    targetModel,
                                    deks.primary,
                                );
                            }
                        }
                    }

                    const result = await query(args);

                    // ── Read / result-decrypt path ──
                    if (isRead) {
                        // Symmetrical with the write path, and the symmetry is
                        // load-bearing: if reads kept fanning out while writes
                        // stopped, a row written before this change would still
                        // decrypt and the narrowing would look harmless right
                        // up until the cache turned over.
                        const targetModel = model;
                        walkReadResult(result, targetModel, deks);
                    }

                    return result;
                },
            },
        },
    }) as T;
}

// ─── Test-only helpers ───────────────────────────────────────────────

/**
 * @internal — kept as a no-op so the existing v5 test suite calls
 * still compile. Prisma 7 extensions are stateless re: registration
 * (no `installed` guard), so there's nothing to reset.
 */
export function _resetEncryptionMiddlewareForTests(): void {
    /* no-op — see docstring */
}

/** @internal — exposed for direct unit-testing of the traversal logic. */
export const _internals = {
    walkWriteArgument,
    walkReadResult,
    encryptDataNode,
    decryptResultNode,
    resolveTenantDekPair,
};
