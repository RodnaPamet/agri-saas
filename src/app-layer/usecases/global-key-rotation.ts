/**
 * Master-KEK rotation for the GLOBAL-key columns — the half the per-tenant job
 * cannot reach.
 *
 * ── the gap ──
 *
 * `src/app-layer/jobs/key-rotation.ts` sweeps `v1:` ciphertexts per tenant. Two
 * things keep it away from most of the data:
 *
 *   1. It iterates `ENCRYPTED_FIELDS` only. The PII manifest —
 *      `PII_FIELD_MAP` in `pii-middleware.ts`, covering `User`,
 *      `UserIdentityLink`, `NotificationOutbox` and `Account` — is a SECOND
 *      encryption manifest it has never heard of.
 *   2. It does `if (!hasTenantId) continue`. `User` and `Account` have no
 *      `tenantId`, so even a manifest union would skip them.
 *
 * Measured on production 2026-10-02: the per-tenant job could re-encrypt
 * **0** values, while **40** `v1:` values sat in the PII manifest — 6 user
 * emails, 6 names, 6 OAuth access tokens, 6 refresh tokens, 16 outbox
 * addresses. So a KEK rotation re-wrapped three DEKs and moved nothing, which
 * means `DATA_ENCRYPTION_KEY_PREVIOUS` could never be retired and an exposed
 * key stayed able to decrypt everything.
 *
 * ── what this does differently, and why each difference is load-bearing ──
 *
 * **It derives from BOTH manifests.** One sweep, one union. A sweep blind to a
 * manifest is the defect above, and the only structural defence is to not have
 * a second list to forget.
 *
 * **It PROVES it can see every column before touching anything.** The existing
 * job's `continue` on a missing `tenantId` is a skip that cannot be
 * distinguished from "nothing to do". `assertSweepableColumns` queries
 * `information_schema` and THROWS, naming what is missing. A sweep that cannot
 * see a column must fail, never quietly cover less.
 *
 * **It does not filter by tenant.** A `v1:` envelope IS the master-KEK envelope
 * by definition, so every v1 value needs moving regardless of which tenant (if
 * any) owns the row. That subsumes the per-tenant job's v1 work entirely.
 *
 * **It skips values already under the primary key.** `encryptField` emits `v1:`,
 * so a migrated row is still `v1:` and `LIKE 'v1:%'` matches it forever.
 * `isV1UnderPrimaryKey` is what makes a re-run converge and makes `remaining`
 * mean something — see that function's docblock.
 *
 * ── what it deliberately does NOT do ──
 *
 * `v2:` ciphertexts. They are wrapped under a per-tenant DEK, not the master
 * KEK, so a master rotation leaves them correct; re-wrapping the DEK is the
 * per-tenant job's business and stays there.
 *
 * Lookup HASHES. `emailHash` and `emailAtLinkTimeHash` derive from
 * `LOOKUP_HMAC_KEY` (P1.1), not from the master KEK, so a KEK rotation does not
 * move them and nothing needs rehashing. That is the entire point of P1.1 and
 * it is why this sweep is a pure ciphertext migration. Before P1.1 this file
 * could not have existed without a rehash pass beside it.
 */
import { Prisma } from '@prisma/client';
import { internal } from '@/lib/errors/types';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import {
    encryptField,
    decryptField,
    isV1UnderPrimaryKey,
    kekRotationInFlight,
} from '@/lib/security/encryption';
import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';
import { unwrapDek, wrapDek, isWrappedDek } from '@/lib/security/tenant-keys';
import {
    clearTenantDekCache,
    getTenantDek,
    getTenantPreviousDek,
} from '@/lib/security/tenant-key-manager';
import { decryptWithKeyOrPrevious } from '@/lib/security/encryption';
import { GLOBAL_KEK_MODELS } from '@/lib/db/encryption-middleware';
import { PII_MANAGED_MODELS, _getPiiFieldMap } from '@/lib/security/pii-middleware';

/** Which manifest a column came from — reported so a reader can see the union. */
export type Manifest = 'encrypted-fields' | 'pii';

export interface SweepableColumn {
    /** Prisma model name, as the manifest spells it. */
    model: string;
    /** PHYSICAL table name — `@@map` makes these differ. */
    table: string;
    /** The name as the manifest spells it, kept for legible errors. */
    manifestName: string;
    /** PHYSICAL column name. This is what reaches raw SQL. */
    column: string;
    manifest: Manifest;
}

/**
 * Resolve a manifest entry to its PHYSICAL table and column.
 *
 * ── why this is not the identity function ──
 *
 * **The two manifests use two different naming conventions**, and nothing says
 * so at either call site:
 *
 *   · `ENCRYPTED_FIELDS` holds PRISMA FIELD names. `PromotionLead.requestMessage`
 *     is `@map("message")`, and the field was named uniquely ON PURPOSE — the
 *     Epic B middleware's fan-out encrypt path matches a FLAT set of field names
 *     across the whole manifest and cannot tell which model a key belongs to,
 *     so a manifest entry called `message` silently encrypted
 *     `Notification.message`, `ExchangeInquiry.message` and
 *     `InsuranceLead.message` too. See the schema comment at
 *     `prisma/schema/promotions.prisma`.
 *   · `PII_FIELD_MAP.encrypted` holds PHYSICAL column names — `emailEncrypted`
 *     IS the `@map` target of the Prisma field `email`.
 *
 * So a sweep that treats manifest names as column names throws 42703 on the
 * first `@map`'d entry — mid-sweep, after rows have already been rewritten.
 * Resolving through the DMMF accepts both spellings and still fails loudly on
 * a name that is neither.
 *
 * Measured 2026-10-02: ZERO `@map`'d encrypted fields sit on tenant-scoped
 * models, which is the only reason the existing per-tenant job has not hit
 * this — it skips `PromotionLead` for having no `tenantId`. The hazard is
 * latent rather than absent, and
 * `tests/guards/encrypted-manifests-resolve-to-columns.test.ts` holds it.
 */
function resolvePhysical(
    modelName: string,
    manifestName: string,
): { table: string; column: string } | null {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
    if (!model) return null;
    const table = model.dbName ?? model.name;

    // Spelling 1 — a Prisma field name. Its `@map` target is the column.
    const byFieldName = model.fields.find((f) => f.name === manifestName);
    if (byFieldName) return { table, column: byFieldName.dbName ?? byFieldName.name };

    // Spelling 2 — already the physical column (what PII_FIELD_MAP holds).
    const byColumn = model.fields.find((f) => f.dbName === manifestName);
    if (byColumn) return { table, column: manifestName };

    return null;
}

export interface ColumnSweepResult {
    model: string;
    column: string;
    /** Rows matching `v1:` that were examined. */
    scanned: number;
    /** Rows re-encrypted under the current primary KEK. */
    rewritten: number;
    /** Rows already readable under the primary key — nothing to do. */
    alreadyPrimary: number;
    /** Rows that failed to decrypt under EITHER key. Needs a human. */
    errors: number;
}

export interface GlobalSweepResult {
    /** False means this run could not have migrated anything — see below. */
    rotationInFlight: boolean;
    /**
     * True when the run covered only SOME columns. Load-bearing for reading
     * `remaining`: a filtered run's zero says "these columns are done", not
     * "the previous key is retirable".
     */
    filtered: boolean;
    columns: number;
    perColumn: ColumnSweepResult[];
    totalScanned: number;
    totalRewritten: number;
    totalAlreadyPrimary: number;
    totalErrors: number;
    /** The tenant-DEK re-wrap, which is not a manifest column. */
    deks: DekRewrapResult;
    /**
     * v1 values still NOT under the primary key after this run — manifest
     * columns AND wrapped DEKs. `previousKeyRetirable` is derived from this, so
     * leaving the DEKs out of it would green-light removing the previous key
     * while every DEK still needed it.
     */
    remaining: number;
    durationMs: number;
}

/**
 * Narrow a sweep to specific columns.
 *
 * Two reasons it exists, and the second is why it is in the production API
 * rather than a test-only hook:
 *
 *   · An operator mid-rotation may want to move the most sensitive column
 *     first — `Account.accessTokenEncrypted` holds third-party OAuth
 *     credentials — and see it finish before committing to the rest.
 *   · A sweep with NO filter re-encrypts every master-KEK value in the
 *     database it is pointed at. That is exactly right in production and
 *     actively harmful in a shared test database, where it would rewrite
 *     unrelated suites' rows under the calling test's key. A test that cannot
 *     scope itself is a test that corrupts its neighbours.
 *
 * Entries are matched on the PRISMA MODEL name plus either spelling of the
 * column (manifest name or physical), so a caller does not have to know which
 * manifest an entry came from.
 */
export interface SweepFilter {
    model: string;
    column: string;
}

/**
 * The columns a run with this filter WOULD cover.
 *
 * Exported so the selection is testable without a database and inspectable
 * before a run: "what am I about to sweep" is a question an operator should be
 * able to ask without sweeping.
 */
export function selectColumns(only?: readonly SweepFilter[]): SweepableColumn[] {
    return applyFilter(sweepableColumns(), only);
}

function applyFilter(columns: SweepableColumn[], only?: readonly SweepFilter[]): SweepableColumn[] {
    if (!only || only.length === 0) return columns;
    const wanted = new Set(only.map((f) => `${f.model}.${f.column}`));
    const selected = columns.filter(
        (c) => wanted.has(`${c.model}.${c.manifestName}`) || wanted.has(`${c.model}.${c.column}`),
    );
    if (selected.length === 0) {
        // An empty selection is a PASS: the sweep would report success over
        // nothing. A filter that matches no column is a typo, not a request.
        throw internal(
            `global-key-rotation: filter matched no column. Asked for ` +
                `${[...wanted].join(', ')}; available models include ` +
                `${[...new Set(columns.map((c) => c.model))].slice(0, 8).join(', ')}.`,
        );
    }
    return selected;
}

/**
 * The WRAPPED-DEK columns, which are master-KEK ciphertext and in NEITHER
 * manifest.
 *
 * ── why this had to be added, and what it was about to cost ──
 *
 * `Tenant.encryptedDek` holds a per-tenant DEK wrapped with `wrapDek`, which is
 * `encryptField` — so it is a `v1:` envelope under the master KEK, unwrapped by
 * `decryptField` with the same dual-key fallback every other ciphertext gets.
 * But it
 * appears in neither `ENCRYPTED_FIELDS` nor `PII_FIELD_MAP`, because it is key
 * material rather than a business field, so the manifest union does not reach it.
 *
 * The first version of this sweep therefore reported `previousKeyRetirable: true`
 * while every DEK was still wrapped under the OLD key. Removing
 * `DATA_ENCRYPTION_KEY_PREVIOUS` on that signal would have made every DEK
 * unwrappable and every `v2:` ciphertext unreadable — a completion signal that
 * did not cover what the decision depends on, which is the same shape as the
 * defect this whole file exists to fix, one level up.
 *
 * ── and why re-wrapping belongs HERE rather than only in the per-tenant job ──
 *
 * `jobs/key-rotation.ts` does re-wrap, but it is reached through
 * `POST /api/t/{slug}/admin/key-rotation`, which needs a tenant ADMIN SESSION
 * per tenant. An operator rotating the master key has a platform key and no
 * reason to hold admin sessions for every tenant on the deployment, so the
 * rotation could not actually be completed from the surface that owns it.
 *
 * `previousEncryptedDek` is included because it is wrapped the same way — it
 * holds the outgoing DEK during a TENANT-DEK rotation (a separate event), and a
 * master rotation must leave it readable too.
 */
const DEK_COLUMNS = ['encryptedDek', 'previousEncryptedDek'] as const;

export interface DekRewrapResult {
    /** Tenants whose DEK was examined. */
    scanned: number;
    /** DEKs re-wrapped under the current primary KEK. */
    rewrapped: number;
    /** DEKs already wrapped under the primary — nothing to do. */
    alreadyPrimary: number;
    errors: number;
}

/** Tenants whose wrapped DEK does NOT read under the current primary KEK. */
export async function countUnwrappedDeks(): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<Array<{ encryptedDek: string | null; previousEncryptedDek: string | null }>>(
        `SELECT "encryptedDek", "previousEncryptedDek" FROM "Tenant"`,
    );
    let n = 0;
    for (const row of rows) {
        for (const col of DEK_COLUMNS) {
            const v = row[col];
            // Only a v1 envelope is a master-KEK question. A null DEK is handled
            // by tenant-key-manager's lazy init and is not outstanding work.
            if (typeof v === 'string' && v.startsWith('v1:') && !isV1UnderPrimaryKey(v)) n++;
        }
    }
    return n;
}

/**
 * Re-wrap every tenant DEK under the current primary KEK.
 *
 * The DEK BYTES do not change — only the wrap — so this is safe to re-run and
 * invisible to every reader. `clearTenantDekCache` is called per tenant so a
 * later request re-unwraps from the new wrap rather than a cached unwrap whose
 * provenance is now stale.
 */
export async function rewrapTenantDeks(): Promise<DekRewrapResult> {
    const out: DekRewrapResult = { scanned: 0, rewrapped: 0, alreadyPrimary: 0, errors: 0 };
    const rows = await prisma.$queryRawUnsafe<
        Array<{ id: string; encryptedDek: string | null; previousEncryptedDek: string | null }>
    >(`SELECT id, "encryptedDek", "previousEncryptedDek" FROM "Tenant" ORDER BY id`);

    for (const row of rows) {
        out.scanned++;
        for (const col of DEK_COLUMNS) {
            const wrapped = row[col];
            if (typeof wrapped !== 'string' || !wrapped.startsWith('v1:')) continue;
            if (isV1UnderPrimaryKey(wrapped)) {
                out.alreadyPrimary++;
                continue;
            }
            if (!isWrappedDek(wrapped)) {
                out.errors++;
                logger.error('global-key-rotation.dek_not_wrapped', {
                    component: 'global-key-rotation',
                    tenantId: row.id,
                    column: col,
                });
                continue;
            }
            try {
                // Dual-KEK unwrap, then wrap under the primary. Identical bytes.
                const fresh = wrapDek(unwrapDek(wrapped));
                await prisma.$executeRawUnsafe(
                    `UPDATE "Tenant" SET "${col}" = $1 WHERE id = $2`,
                    fresh,
                    row.id,
                );
                clearTenantDekCache(row.id);
                out.rewrapped++;
            } catch (err) {
                out.errors++;
                logger.error('global-key-rotation.dek_rewrap_failed', {
                    component: 'global-key-rotation',
                    tenantId: row.id,
                    column: col,
                    error: err instanceof Error ? err.message : 'unknown',
                });
            }
        }
    }
    return out;
}

/**
 * Repairing MISPLACED `v2:` ciphertext — a row encrypted under a tenant DEK on a
 * model that should only ever use the global KEK.
 *
 * ── when this is needed ──
 *
 * Promoting a model into `GLOBAL_KEK_MODELS` fixes every FUTURE write. It does
 * nothing for rows already written under a tenant's DEK, and those rows are the
 * ones with the user-visible problem: #1222, where `ExchangeMessage.body` was
 * encrypted under the WRITER's DEK while `listThreadMessages` reads in the
 * VIEWING party's context, so the other party saw `v2:…` instead of the message.
 * Measured on production: both messages on the only live thread were written by
 * one tenant, so the recipient could read neither.
 *
 * It will be needed again. The `'*'` fan-out encrypts 19 non-manifest models
 * because it matches field NAMES across the whole manifest, so each one promoted
 * into `GLOBAL_KEK_MODELS` (or removed from encryption entirely) arrives with
 * the same question about its existing rows.
 *
 * ── why it cannot be generic ──
 *
 * Decrypting a `v2:` value needs the DEK of the tenant that WROTE it, and only
 * the row knows which tenant that was — under a column whose name is
 * model-specific (`senderTenantId` here, because the row has no `tenantId` at
 * all). So the mapping is declared rather than derived, and a model with
 * misplaced v2 rows and no entry here is an ERROR rather than a skip: silently
 * covering less is how a repair reports success over half the data.
 */
const V2_REPAIR_TENANT_COLUMN: Readonly<Record<string, string>> = {
    // The row has no `tenantId`; `senderTenantId` records which side wrote it,
    // and the schema says it is stored "rather than derived so a message stays
    // attributable after a listing is edited or a thread is closed".
    ExchangeMessage: 'senderTenantId',
};

export interface V2RepairResult {
    model: string;
    column: string;
    /** Rows carrying a `v2:` value on a global-KEK model. */
    found: number;
    /** Rows moved to a `v1:` envelope under the global KEK. */
    repaired: number;
    errors: number;
}

/** The columns a v2 repair covers: manifest columns of global-KEK models. */
function v2RepairColumns(): SweepableColumn[] {
    return sweepableColumns().filter((c) => GLOBAL_KEK_MODELS.has(c.model));
}

/**
 * Misplaced `v2:` values — the signal that a repair is outstanding.
 *
 * READ THE SCOPE BEFORE TRUSTING THE NUMBER. This answers "which global-KEK
 * rows are still under a tenant DEK", NOT "which rows hold `v2:`". Those read
 * as the same question right up until a field leaves the manifest, and then
 * they diverge silently:
 *
 *     v2RepairColumns() = sweepableColumns() ∩ GLOBAL_KEK_MODELS
 *     sweepableColumns() = ENCRYPTED_FIELDS ∪ PII_MANAGED_MODELS
 *
 * So a model that is correctly tenant-scoped is filtered out by the
 * intersection, and a field NARROWED TO PLAINTEXT leaves `ENCRYPTED_FIELDS`
 * and so never enters the union at all. Narrowing a field to plaintext is BY
 * DEFINITION removing it from the manifest, which means no manifest-driven
 * counter — this one or any future one built the same way — can see the rows
 * that a narrowing orphans. A sweep that must catch those has to derive its
 * columns from the SCHEMA SHAPE instead (see `scripts/count-fanout-encrypted.ts`,
 * which pairs manifest NAMES against schema models and therefore still sees a
 * field on its way out).
 *
 * Identified by Agrent backend 1 while scoping the 18-model narrowing in #1222,
 * after I told them this counter would widen to cover their half. It will not:
 * their models add nothing to `GLOBAL_KEK_MODELS`, so every one of them is
 * invisible here — structurally, not by omission.
 */
export async function countMisplacedV2(): Promise<number> {
    let n = 0;
    for (const { table, column } of v2RepairColumns()) {
        const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT count(*)::bigint AS n FROM "${table}"
              WHERE "${column}" IS NOT NULL AND "${column}" LIKE 'v2:%'`,
        );
        n += Number(rows[0]?.n ?? 0);
    }
    return n;
}

/**
 * Move misplaced `v2:` values onto the global KEK.
 *
 * Decrypts with the WRITING tenant's DEK (primary, falling back to that
 * tenant's previous DEK if a per-tenant rotation is mid-flight) and re-encrypts
 * with `encryptField`. Idempotent: a value already `v1:` is not selected.
 */
export async function repairMisplacedV2(): Promise<V2RepairResult[]> {
    const out: V2RepairResult[] = [];

    for (const { model, table, column } of v2RepairColumns()) {
        const result: V2RepairResult = { model, column, found: 0, repaired: 0, errors: 0 };
        const tenantColumn = V2_REPAIR_TENANT_COLUMN[model];

        const rows = await prisma.$queryRawUnsafe<Array<{ id: string; value: string; tenant: string | null }>>(
            `SELECT id, "${column}" AS value${tenantColumn ? `, "${tenantColumn}" AS tenant` : ', NULL AS tenant'}
               FROM "${table}"
              WHERE "${column}" IS NOT NULL AND "${column}" LIKE 'v2:%'
              ORDER BY id`,
        );
        result.found = rows.length;

        if (rows.length > 0 && !tenantColumn) {
            // Loud, not skipped: the rows exist and cannot be attributed, so
            // nothing can decrypt them and a human has to decide.
            result.errors = rows.length;
            logger.error('global-key-rotation.v2_repair_unattributable', {
                component: 'global-key-rotation',
                model,
                column,
                rows: rows.length,
                detail:
                    'misplaced v2 rows on a global-KEK model with no entry in ' +
                    'V2_REPAIR_TENANT_COLUMN — cannot tell which tenant DEK wrote them',
            });
            out.push(result);
            continue;
        }

        for (const row of rows) {
            if (!row.tenant) {
                result.errors++;
                logger.error('global-key-rotation.v2_repair_no_tenant', {
                    component: 'global-key-rotation',
                    model,
                    column,
                    id: row.id,
                });
                continue;
            }
            try {
                const primary = await getTenantDek(row.tenant);
                const previous = await getTenantPreviousDek(row.tenant);
                const plaintext = decryptWithKeyOrPrevious(primary, previous, row.value);
                await prisma.$executeRawUnsafe(
                    `UPDATE "${table}" SET "${column}" = $1 WHERE id = $2`,
                    encryptField(plaintext),
                    row.id,
                );
                result.repaired++;
            } catch (err) {
                result.errors++;
                logger.error('global-key-rotation.v2_repair_failed', {
                    component: 'global-key-rotation',
                    model,
                    column,
                    id: row.id,
                    error: err instanceof Error ? err.message : 'unknown',
                });
            }
        }
        out.push(result);
    }

    return out;
}

/** Default rows per SELECT. Small because each row costs two AES operations. */
const DEFAULT_BATCH = 200;

/** Identifiers reach raw SQL, so they are validated rather than trusted. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(name: string, kind: string): void {
    if (!IDENT_RE.test(name)) {
        throw internal(`global-key-rotation: invalid ${kind}: ${JSON.stringify(name)}`);
    }
}

/**
 * Every column holding master-KEK ciphertext, from BOTH manifests.
 *
 * Deterministic order (model, then column) so two runs report comparably and a
 * diff of the output is readable.
 */
export function sweepableColumns(): SweepableColumn[] {
    const raw: Array<{ model: string; manifestName: string; manifest: Manifest }> = [];

    for (const [model, fields] of Object.entries(ENCRYPTED_FIELDS)) {
        for (const manifestName of fields) raw.push({ model, manifestName, manifest: 'encrypted-fields' });
    }

    for (const model of PII_MANAGED_MODELS) {
        for (const spec of _getPiiFieldMap(model) ?? []) {
            // `.encrypted` is the ciphertext column. `.plain` is either @map'd
            // onto it or a legacy dual-write plaintext — neither is ciphertext,
            // and re-encrypting a plaintext column would be data loss.
            raw.push({ model, manifestName: spec.encrypted, manifest: 'pii' });
        }
    }

    const out: SweepableColumn[] = [];
    const unresolved: string[] = [];
    for (const r of raw) {
        const phys = resolvePhysical(r.model, r.manifestName);
        if (!phys) {
            unresolved.push(`${r.model}.${r.manifestName} (${r.manifest})`);
            continue;
        }
        out.push({ ...r, table: phys.table, column: phys.column });
    }
    if (unresolved.length > 0) {
        // Collected rather than thrown per-entry so one run names every
        // mismatch. A manifest entry naming nothing in the datamodel is a stale
        // manifest, and continuing would sweep a smaller population while
        // reporting success.
        throw internal(
            `global-key-rotation: ${unresolved.length} manifest entr(y/ies) resolve to no ` +
                `Prisma field or column:\n  ${unresolved.join('\n  ')}\n` +
                `  Fix the manifest, or the schema. A sweep must not cover less than it claims.`,
        );
    }

    // A column could in principle appear in both manifests; sweeping it twice
    // is harmless but the counts would double-report, which is worse than it
    // sounds — it makes `remaining` disagree with reality.
    // Deduped on the PHYSICAL pair: two manifests can name the same column by
    // different spellings (a Prisma field name and its `@map` target), and
    // sweeping it twice would make `remaining` disagree with reality.
    const seen = new Set<string>();
    return out
        .filter((c) => {
            const k = `${c.table}.${c.column}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        })
        .sort((a, b) => (a.table === b.table ? a.column.localeCompare(b.column) : a.table.localeCompare(b.table)));
}

/**
 * Refuse to sweep unless every column — and every `id` the UPDATE needs —
 * actually exists.
 *
 * This is the half the existing job gets wrong. A sweep that skips what it
 * cannot find reports success over a smaller population, and the report looks
 * identical to a complete one.
 */
export async function assertSweepableColumns(columns: SweepableColumn[]): Promise<void> {
    if (columns.length === 0) {
        throw internal(
            'global-key-rotation: derived ZERO columns. Both manifests cannot be ' +
                'empty — the derivation is broken, and sweeping nothing would report success.',
        );
    }
    for (const c of columns) {
        assertIdentifier(c.table, 'table');
        assertIdentifier(c.column, 'column');
    }

    const models = [...new Set(columns.map((c) => c.table))];
    const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = ANY($1::text[])`,
        models,
    );
    const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));

    const missing = columns.filter((c) => !have.has(`${c.table}.${c.column}`));
    // The UPDATE addresses rows by `id`; a model without one would fail
    // mid-sweep, after some rows had already been rewritten.
    const noId = models.filter((m) => !have.has(`${m}.id`));

    if (missing.length > 0 || noId.length > 0) {
        throw internal(
            'global-key-rotation: refusing to sweep — the schema does not match the manifests.\n' +
                (missing.length
                    ? `  missing columns: ${missing.map((c) => `${c.table}.${c.column} — manifest says ${c.model}.${c.manifestName} (${c.manifest})`).join(', ')}\n`
                    : '') +
                (noId.length ? `  models with no "id" column: ${noId.join(', ')}\n` : '') +
                '  Fix the manifest or the schema. Skipping what cannot be found is how a ' +
                'rotation reports success over half the data.',
        );
    }
}

/** Count v1 values NOT yet under the primary key. The completion signal. */
export async function countUnmigrated(only?: readonly SweepFilter[]): Promise<{
    total: number;
    perColumn: Array<{ model: string; column: string; unmigrated: number; v1Total: number }>;
}> {
    const all = sweepableColumns();
    // Validated over the WHOLE union even when filtered: a stale manifest entry
    // is a fact about the deployment, not about the columns you asked for, and
    // finding out later is worse.
    await assertSweepableColumns(all);
    const columns = applyFilter(all, only);

    const perColumn: Array<{ model: string; column: string; unmigrated: number; v1Total: number }> = [];
    let total = 0;

    for (const { model, table, column } of columns) {
        const rows = await prisma.$queryRawUnsafe<Array<{ id: string; value: string }>>(
            `SELECT id, "${column}" AS value FROM "${table}"
              WHERE "${column}" IS NOT NULL AND "${column}" LIKE 'v1:%'`,
        );
        // Counted in Node, not SQL: "is this readable under the primary key" is
        // an AES operation, and Postgres cannot answer it.
        const unmigrated = rows.filter((r) => !isV1UnderPrimaryKey(r.value)).length;
        perColumn.push({ model, column, unmigrated, v1Total: rows.length });
        total += unmigrated;
    }

    return { total, perColumn };
}

/**
 * Re-encrypt every global-KEK ciphertext under the current primary KEK.
 *
 * Idempotent and re-runnable: a row already under the primary key is counted
 * and left alone, so running this until `remaining === 0` converges.
 */
export async function sweepGlobalKeyRotation(
    opts: { batchSize?: number; only?: readonly SweepFilter[] } = {},
): Promise<GlobalSweepResult> {
    const started = Date.now();
    const batchSize = Math.max(1, Math.min(opts.batchSize ?? DEFAULT_BATCH, 2000));
    const all = sweepableColumns();
    await assertSweepableColumns(all);
    const columns = applyFilter(all, opts.only);

    const rotationInFlight = kekRotationInFlight();
    if (!rotationInFlight) {
        // Not an error — a sweep can legitimately mop up stragglers after a
        // rotation has finished. But it CANNOT move anything off an old key,
        // and a `rewritten` count from such a run reads like progress it is
        // not making. Say so once, loudly, in the log and the result.
        logger.warn('global-key-rotation.no_previous_key', {
            component: 'global-key-rotation',
            detail:
                'DATA_ENCRYPTION_KEY_PREVIOUS is not configured, so nothing can be ' +
                'migrated off an old key. Values are re-encrypted under the key they ' +
                'already carry.',
        });
    }

    const perColumn: ColumnSweepResult[] = [];

    for (const { model, table, column } of columns) {
        const result: ColumnSweepResult = { model, column, scanned: 0, rewritten: 0, alreadyPrimary: 0, errors: 0 };

        // Cursor on `id` rather than OFFSET: rows are UPDATEd as we go and an
        // OFFSET walk over a changing set skips rows. The predicate does not
        // change under us (a rewritten row is still `v1:`), so a plain
        // ascending cursor is both stable and complete.
        let after: string | null = null;
        for (;;) {
            const rows: Array<{ id: string; value: string }> = await prisma.$queryRawUnsafe(
                `SELECT id, "${column}" AS value FROM "${table}"
                  WHERE "${column}" IS NOT NULL AND "${column}" LIKE 'v1:%'
                    ${after === null ? '' : 'AND id > $2'}
                  ORDER BY id
                  LIMIT $1`,
                ...(after === null ? [batchSize] : [batchSize, after]),
            );
            if (rows.length === 0) break;

            for (const row of rows) {
                result.scanned++;
                after = row.id;

                if (isV1UnderPrimaryKey(row.value)) {
                    result.alreadyPrimary++;
                    continue;
                }

                let plaintext: string;
                try {
                    plaintext = decryptField(row.value);
                } catch (err) {
                    result.errors++;
                    logger.error('global-key-rotation.decrypt_failed', {
                        component: 'global-key-rotation',
                        model,
                        column,
                        id: row.id,
                        error: err instanceof Error ? err.message : 'unknown',
                    });
                    continue;
                }

                try {
                    // Raw SQL so neither the encryption extension nor
                    // pii-middleware touches the value — the middleware would
                    // re-encrypt an already-encrypted string, or map the column
                    // away entirely.
                    await prisma.$executeRawUnsafe(
                        `UPDATE "${table}" SET "${column}" = $1 WHERE id = $2`,
                        encryptField(plaintext),
                        row.id,
                    );
                    result.rewritten++;
                } catch (err) {
                    result.errors++;
                    logger.error('global-key-rotation.update_failed', {
                        component: 'global-key-rotation',
                        model,
                        column,
                        id: row.id,
                        error: err instanceof Error ? err.message : 'unknown',
                    });
                }
            }

            if (rows.length < batchSize) break;
        }

        perColumn.push(result);
    }

    // ── the wrapped DEKs ──
    //
    // Only on an UNFILTERED run. A filter names manifest COLUMNS, and a DEK is
    // not one; re-wrapping key material because someone asked to sweep
    // `User.emailEncrypted` would be a side effect they did not request. The
    // unfiltered run is the "finish the rotation" run, which is exactly where
    // this belongs.
    const filtered = columns.length !== all.length;
    const deks: DekRewrapResult = filtered
        ? { scanned: 0, rewrapped: 0, alreadyPrimary: 0, errors: 0 }
        : await rewrapTenantDeks();

    // Scoped to what this run swept. An unfiltered run therefore reports the
    // deployment-wide figure (which is what `previousKeyRetirable` needs) and
    // INCLUDES the wrapped DEKs; a filtered run reports only its own columns —
    // never a number that mixes the two.
    const { total: columnsRemaining } = await countUnmigrated(opts.only);
    const remaining = filtered ? columnsRemaining : columnsRemaining + (await countUnwrappedDeks());
    const sum = (f: (r: ColumnSweepResult) => number): number => perColumn.reduce((a, r) => a + f(r), 0);

    const out: GlobalSweepResult = {
        rotationInFlight,
        filtered,
        columns: columns.length,
        deks,
        perColumn,
        totalScanned: sum((r) => r.scanned),
        totalRewritten: sum((r) => r.rewritten),
        totalAlreadyPrimary: sum((r) => r.alreadyPrimary),
        totalErrors: sum((r) => r.errors),
        remaining,
        durationMs: Date.now() - started,
    };

    logger.info('global-key-rotation.completed', {
        component: 'global-key-rotation',
        rotationInFlight,
        filtered,
        columns: out.columns,
        deksRewrapped: deks.rewrapped,
        dekErrors: deks.errors,
        scanned: out.totalScanned,
        rewritten: out.totalRewritten,
        alreadyPrimary: out.totalAlreadyPrimary,
        errors: out.totalErrors,
        remaining: out.remaining,
        durationMs: out.durationMs,
    });

    return out;
}
