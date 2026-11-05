/**
 * Reading and writing ENCRYPTED columns from work that spans several farms.
 *
 * ## The rule, and the silence that makes it worth a shared module
 *
 * A tenant-keyed encrypted column — anything in `ENCRYPTED_FIELDS` whose model
 * is NOT in `GLOBAL_KEK_MODELS` — is protected by that FARM's DEK, and
 * `resolveTenantDekPair` takes the farm from the AUDIT CONTEXT. It has to: it
 * needs the key before the row arrives, so it cannot read `row.tenantId`.
 *
 * With no farm bound, that resolution returns `NO_DEK_PAIR`, and the two
 * directions fail differently — both silently:
 *
 *   · a READ hands back the `v2:` ENVELOPE. No error, no log. The row looks
 *     populated and the string is ciphertext. Measured 2026-11-02 (#2723):
 *     the assistant's past-conversation list showed `v2:8X18HAVp…` as every
 *     row's label, and its recall tool compared a search needle against an
 *     envelope, so it matched NOTHING for every query ever made.
 *   · a WRITE falls back to the `v1:` GLOBAL KEK. It reads back perfectly —
 *     the extension dispatches per value on the envelope — so nothing ever
 *     looks wrong, and the only thing lost is per-tenant key isolation: the
 *     property `GLOBAL_KEK_MODELS` exists to protect, whose own comment says
 *     a tenant-scoped model must not join that set "precisely because it
 *     would throw that isolation away". A context-less write throws it away
 *     by accident, one row at a time.
 *
 * `memory-extract.ts` stated the read half first: a cross-tenant batch "would
 * have to pick a single tenant context and would silently return ciphertext —
 * or nothing — for every other farm in the batch. The read is per-tenant
 * because the KEY is per-tenant." Three readers one file away broke it anyway,
 * because nothing connected the rule to the code. This module is where the
 * rule and the code are the same thing.
 *
 * ## What it is NOT
 *
 * Not a general query wrapper. Reach for it only when the work genuinely spans
 * farms — a cross-tenant sweep, or a PERSON-scoped question whose answer
 * covers every farm they belong to. Anything with one farm in hand should use
 * `runInTenantContext` / `withTenantDb` directly, which is simpler and what
 * the `no-direct-prisma` guard asks of a usecase.
 */
import { withTenantDb, type PrismaTx } from '@/lib/db-context';
import { logger } from '@/lib/observability';

/** The minimum a row needs for its content to be fetchable. */
export interface TenantScopedRow {
    id: string;
    tenantId: string;
}

/**
 * Run `read` once per distinct farm, inside that farm's context, and
 * concatenate the results.
 *
 * The loop is over FARMS, never over rows: a cross-tenant sweep may hold
 * thousands of rows across a handful of farms, and a context per row would be
 * an N+1 over the larger number.
 *
 * Results come back in farm order, not in the caller's row order. A caller
 * whose order matters — a scan budget that returns early, a list sorted by
 * date — must index these by id and iterate its OWN rows, which is why this
 * returns a flat array rather than pretending to preserve an order it cannot.
 */
export async function readContentPerTenant<T>(
    rows: ReadonlyArray<TenantScopedRow>,
    read: (db: PrismaTx, ids: string[], tenantId: string) => Promise<T[]>,
): Promise<T[]> {
    const byTenant = new Map<string, string[]>();
    for (const row of rows) {
        const seen = byTenant.get(row.tenantId);
        if (seen) seen.push(row.id);
        else byTenant.set(row.tenantId, [row.id]);
    }

    const out: T[] = [];
    for (const [tenantId, ids] of byTenant) {
        /*
         * guardrail-allow: n+1 — one read per FARM, and it cannot be hoisted.
         * The key is per tenant, so a single query would have to pick one
         * context and return ciphertext for every other farm. Bounded by the
         * number of farms, which is far below the row count.
         */
        out.push(...(await withTenantDb(tenantId, (db) => read(db, ids, tenantId))));
    }
    return out;
}

/** A value still carrying an envelope was never decrypted. */
const CIPHERTEXT_ENVELOPE = /^v[12]:/;

/**
 * Refuse to hand an ENVELOPE to a client, whatever went wrong upstream.
 *
 * `readContentPerTenant` makes the DEK resolvable; it cannot make it resolve.
 * `resolveTenantDekPair` logs a warning and returns `NO_DEK_PAIR` when the
 * lookup FAILS, and the extension then passes the ciphertext through — the
 * same silent shape, reachable again for an entirely different reason.
 *
 * `null` means "stored, and this server could not read it": a degraded answer
 * rather than a wrong one. An envelope rendered as a person's own words is
 * both wrong and a leak of our storage format.
 *
 * Deliberately NOT a throw. On a cross-farm list, one farm with an
 * unresolvable key would break the whole answer; on a transcript it would
 * discard the rows that DID decrypt.
 */
export function readableOrNull(value: string, at: string, rowId: string): string | null {
    if (!CIPHERTEXT_ENVELOPE.test(value)) return value;
    logger.warn('encryption.ciphertext_reached_boundary', {
        component: 'per-tenant-content',
        at,
        rowId,
        // Never the value: it is content under an envelope we could not open,
        // and the envelope is not the useful part.
        envelope: value.slice(0, 3),
    });
    return null;
}
