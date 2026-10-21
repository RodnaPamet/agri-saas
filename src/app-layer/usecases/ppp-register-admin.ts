/**
 * Load the БАБХ register of approved plant-protection products (#2077).
 *
 * ── Why an upload and not a scheduled fetch ──────────────────────────────
 *
 * Owner's ruling, 2026-10-20. We own neither the register's format nor its
 * URL, so a parser pointed at them can break overnight — and the failure is
 * not an exception, it is WRONG DOSES rendered identically to right ones. A
 * manual upload makes a refresh a deliberate act with a known date, which
 * turns staleness from silent into visible. On a figure a farmer may transcribe
 * onto a regulated document, that property is worth more than the automation.
 *
 * ── Why the platform-SUPPORT gate ────────────────────────────────────────
 *
 * The register has no `tenantId`: it is national, identical for every farm, and
 * classified `GLOBAL_BY_DESIGN` alongside `MarketPriceSeries`. So this is
 * platform curation, and a tenant-facing writer would let one farm rewrite the
 * approved doses every other farm reads.
 *
 * `verifyPlatformApiKey` was the other candidate and is the wrong one here, for
 * the reason `market-manual-prices.ts` sets out at length: a header key has no
 * session, `AuditLog.tenantId` is non-nullable with a per-tenant hash chain, so
 * a keyed request has no tenant to hang an audit row on. `assertPlatformSupport`
 * + `admin.manage` inside `PLATFORM_TENANT_SLUG` has a real session, so the
 * write gets a real `userId` — which is also what `importedById` stores. A
 * national register being replaced deserves a trail with a person on it.
 *
 * **Reachability, measured rather than quoted:** `/api/readyz` on
 * `app.agrent.bg` reports `capabilities.platformConsole.state: "reachable"`
 * (2026-10-21), so the gate is open in production and an operator can load the
 * register as soon as this ships. Worth saying how that was established:
 * `platform-console-capability.ts` carried a probe from 2026-10-12 reading
 * ABSENT, this module was first written documented as unreachable on the
 * strength of it, and the slug had in fact been configured on 2026-10-13. The
 * capability endpoint exists so that question has a current answer — a comment
 * repeating a nine-day-old probe is not one.
 *
 * ── An import is a SNAPSHOT, never an accumulation ───────────────────────
 *
 * The read uses the latest COMPLETED import and nothing else. Older imports are
 * kept for provenance — a suggestion can carry the date it came from — but are
 * never merged. Merging would let a row withdrawn in the newest file still
 * match from an older one, which is the single worst thing this table can do.
 *
 * @module app-layer/usecases/ppp-register-admin
 */
import { Prisma } from '@prisma/client';
import type { RequestContext } from '../types';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import type { ParsedPppRegister } from '@/lib/agro/ppp-register-parse';

/**
 * Rows per `createMany`. The real register is ~4000 rows, so this is four
 * statements rather than one of 4000 parameters or 4000 of one.
 */
export const ENTRY_INSERT_CHUNK = 1000;

/**
 * Longest a single parsed cell may be.
 *
 * Not a storage limit — the columns are `TEXT`. It is a MIS-BINDING detector:
 * the realistic way this parser goes wrong is binding `productName` to a notes
 * or conditions-of-use column, and the tell is values hundreds of characters
 * long. Refusing names the row, which is a far better failure than a register
 * whose product names are paragraphs.
 */
export const MAX_CELL_LENGTH = 300;

/** Most pests one row may list before the cell is more likely prose. */
export const MAX_PESTS_PER_ENTRY = 60;

/**
 * Transaction budget for the write.
 *
 * Four `createMany` statements plus two single-row writes, so the default 5s
 * is probably enough — but an import that times out half-written is exactly
 * the state `completedAt` exists to make harmless, and there is no reason to
 * lean on that routinely.
 */
const IMPORT_TX_TIMEOUT_MS = 60_000;
const IMPORT_TX_MAX_WAIT_MS = 10_000;

export interface PppRegisterImportResult {
    importId: string;
    entryCount: number;
    /**
     * Rows in the import this one replaces, or null if it is the first.
     *
     * Reported BESIDE the new count on purpose: an operator who uploads a
     * truncated export sees `entryCount: 40, previousEntryCount: 4100` in the
     * response and knows immediately. Without the second number, 40 looks like
     * a successful import.
     */
    previousEntryCount: number | null;
    skippedRows: number;
    unparsedDoses: number;
    withdrawnCount: number;
    /** Headers the parser bound, so a shape change is visible in the response. */
    headers: string[];
}

/** A dose bound as a Prisma Decimal, or null. */
function dose(value: number | null): Prisma.Decimal | null {
    return value === null ? null : new Prisma.Decimal(value);
}

/**
 * Refuse a parse whose values say the columns were bound wrong.
 *
 * Checked before anything is written, and it refuses the WHOLE import rather
 * than dropping the offending rows. A national register is used as a unit: a
 * version with an arbitrary subset silently missing is worse than no new
 * version at all, because a miss reads as "nothing is approved for this crop".
 */
function assertPlausible(parsed: ParsedPppRegister): void {
    for (const e of parsed.entries) {
        const longest = Math.max(
            e.crop.length,
            e.productName.length,
            e.pppRegistrationNo?.length ?? 0,
            e.doseUnit?.length ?? 0,
        );
        if (longest > MAX_CELL_LENGTH) {
            throw badRequest(
                `A cell is ${longest} characters long, which almost always means a column was ` +
                    `bound to the wrong field. Row: crop=${JSON.stringify(e.crop.slice(0, 60))}, ` +
                    `product=${JSON.stringify(e.productName.slice(0, 60))}. ` +
                    `Headers bound: ${parsed.headers.join(' | ')}.`,
            );
        }
        if (e.pests.length > MAX_PESTS_PER_ENTRY) {
            throw badRequest(
                `A row lists ${e.pests.length} pests, over the limit of ${MAX_PESTS_PER_ENTRY} — ` +
                    `the pest column is more likely bound to prose. ` +
                    `Row: ${JSON.stringify(e.productName.slice(0, 60))}.`,
            );
        }
    }
}

export async function importPppRegister(
    ctx: RequestContext,
    input: { parsed: ParsedPppRegister; sourceName: string },
): Promise<PppRegisterImportResult> {
    assertPlatformSupport(ctx);
    const { parsed, sourceName } = input;

    // An EMPTY import is refused rather than stored. It would become the live
    // register and turn every lookup into a miss — and a miss is rendered as
    // "no approved product", which is a statement about Bulgarian law that an
    // empty spreadsheet is not entitled to make.
    if (parsed.entries.length === 0) {
        throw badRequest(
            `The file bound its columns (${parsed.headers.join(' | ')}) but produced no rows ` +
                `(${parsed.skippedRows} row(s) had no crop or no product name). ` +
                `Refusing to replace the live register with an empty one.`,
        );
    }
    assertPlausible(parsed);

    const withdrawnCount = parsed.entries.filter((e) => e.withdrawn).length;

    return runInTenantContext(
        ctx,
        async (db) => {
            const previous = await db.pppRegisterImport.findFirst({
                where: { completedAt: { not: null } },
                orderBy: { importedAt: 'desc' },
                select: { entryCount: true },
            });

            const created = await db.pppRegisterImport.create({
                data: {
                    importedById: ctx.userId,
                    sourceName,
                    entryCount: parsed.entries.length,
                    // completedAt stays NULL until every entry is in. See the
                    // schema comment: this is what keeps a half-written import
                    // from becoming the live register.
                },
                select: { id: true },
            });

            for (let i = 0; i < parsed.entries.length; i += ENTRY_INSERT_CHUNK) {
                const chunk = parsed.entries.slice(i, i + ENTRY_INSERT_CHUNK);
                await db.pppRegisterEntry.createMany({
                    data: chunk.map((e) => ({
                        importId: created.id,
                        crop: e.crop,
                        productName: e.productName,
                        pppRegistrationNo: e.pppRegistrationNo,
                        pests: e.pests,
                        doseMin: dose(e.doseMin),
                        doseMax: dose(e.doseMax),
                        doseUnit: e.doseUnit,
                        quarantinePeriodDays: e.quarantinePeriodDays,
                        withdrawn: e.withdrawn,
                    })),
                });
            }

            // LAST. Everything above is invisible to the read until this line.
            await db.pppRegisterImport.update({
                where: { id: created.id },
                data: { completedAt: new Date() },
            });

            await logEvent(db, ctx, {
                action: 'PPP_REGISTER_IMPORT',
                entityType: 'PppRegisterImport',
                entityId: created.id,
                details:
                    `Imported ${parsed.entries.length} ПРЗ register entries from ` +
                    `${sourceName} (previous import: ${previous?.entryCount ?? 'none'})`,
                detailsJson: {
                    // `entity_lifecycle` / `created`, which is what this is: a
                    // new import entity. NB the canonical AuditDetailsSchema
                    // only accepts the four `data_lifecycle` operations, and
                    // 'imported' is not one of them — see #2109.
                    category: 'entity_lifecycle',
                    entityName: 'PppRegisterImport',
                    operation: 'created',
                    summary:
                        `ПРЗ register replaced: ${parsed.entries.length} entries ` +
                        `(${withdrawnCount} withdrawn) from ${sourceName}`,
                    after: {
                        sourceName,
                        entryCount: parsed.entries.length,
                        previousEntryCount: previous?.entryCount ?? null,
                        withdrawnCount,
                        skippedRows: parsed.skippedRows,
                        unparsedDoses: parsed.unparsedDoses,
                        headers: parsed.headers,
                    },
                },
            });

            return {
                importId: created.id,
                entryCount: parsed.entries.length,
                previousEntryCount: previous?.entryCount ?? null,
                skippedRows: parsed.skippedRows,
                unparsedDoses: parsed.unparsedDoses,
                withdrawnCount,
                headers: parsed.headers,
            };
        },
        { timeout: IMPORT_TX_TIMEOUT_MS, maxWait: IMPORT_TX_MAX_WAIT_MS },
    );
}

export interface PppRegisterState {
    /** Null when no import has ever completed — the register is not loaded. */
    live: {
        importId: string;
        importedAt: Date;
        sourceName: string;
        entryCount: number;
        withdrawnCount: number;
        /** Entries actually stored, which should equal `entryCount`. */
        storedEntries: number;
    } | null;
    /** Imports that never completed. Non-zero means an upload died part-way. */
    incompleteImports: number;
}

/**
 * What is live, for the operator who just uploaded it.
 *
 * Exists so an upload is verifiable without database access. `storedEntries` is
 * counted rather than read from the import row deliberately: the two agreeing
 * is the evidence that the snapshot is whole, and reporting only the stored
 * figure would make the check circular.
 */
export async function describePppRegister(ctx: RequestContext): Promise<PppRegisterState> {
    assertPlatformSupport(ctx);

    return runInTenantContext(ctx, async (db) => {
        const [live, incompleteImports] = await Promise.all([
            db.pppRegisterImport.findFirst({
                where: { completedAt: { not: null } },
                orderBy: { importedAt: 'desc' },
                select: { id: true, importedAt: true, sourceName: true, entryCount: true },
            }),
            db.pppRegisterImport.count({ where: { completedAt: null } }),
        ]);

        if (!live) return { live: null, incompleteImports };

        const [storedEntries, withdrawnCount] = await Promise.all([
            db.pppRegisterEntry.count({ where: { importId: live.id } }),
            db.pppRegisterEntry.count({ where: { importId: live.id, withdrawn: true } }),
        ]);

        return {
            live: {
                importId: live.id,
                importedAt: live.importedAt,
                sourceName: live.sourceName,
                entryCount: live.entryCount,
                withdrawnCount,
                storedEntries,
            },
            incompleteImports,
        };
    });
}
