import prisma from '@/lib/prisma';
import { hashForLookupCandidates } from '@/lib/security/encryption';
import { logger } from '@/lib/observability/logger';

/**
 * The per-tenant actor a BACKGROUND JOB writes as, where a column demands a
 * real `User` row — #2729.
 *
 * ## Why a row at all, when jobs already have a "system" actor
 *
 * Five of the six `makeSystemCtx` helpers across `src/app-layer/jobs/` set
 * `userId: 'system'`, and that works for a `RequestContext`: it feeds
 * permissions, the audit actor and `app.actor_user_id`, none of which is an FK.
 * `Task.createdByUserId` IS an FK (`String`, NOT NULL, `TaskCreator` to
 * `User`), so the sentinel cannot satisfy it — which is exactly how
 * `retention-notifications` came to call `task.create` through an `as any`
 * with the column omitted.
 *
 * This module is deliberately NARROW (owner decision 2026-11-06): it serves
 * the FK case only. The five sentinel contexts are left alone, because
 * unifying them would touch the audit actor and the RLS session variable in
 * five job modules for a change that fixes one broken write.
 *
 * ## Why PER TENANT rather than one global row
 *
 * `emailHash` is `@unique` and `pii-middleware` derives it from `email` on
 * every write that sets `email`, so distinct rows need distinct addresses.
 * Per-tenant also keeps the audit trail answerable: "which farm's job wrote
 * this" has an answer, where one shared actor would collapse every farm's
 * automated writes into one name.
 *
 * ## Why the address is `.invalid`
 *
 * RFC 2606 reserves it, so it can never resolve. That matters twice: no mail
 * can be delivered to it, and no OAuth sign-in can ever match it, which is
 * what makes `passwordHash: null` sufficient rather than merely tidy. The
 * account is unreachable by construction, not by configuration.
 *
 * ## MUST be resolved BEFORE a tenant transaction opens
 *
 * This reads and may write through the GLOBAL client. Called from inside
 * `withTenantDb`'s callback it would want a SECOND pool connection while the
 * first is held — #1191's P0.8 deadlock, which `PG_POOL_MAX` makes reachable
 * at 12 concurrent transactions and which surfaces as Prisma's `P2028` naming
 * no pool. So callers resolve the id first and pass it in, the same ordering
 * `prewarmTenantKeys` exists to guarantee for the DEK lookup.
 */

/** Reserved by RFC 2606, so it can never resolve. */
const SYSTEM_EMAIL_DOMAIN = 'jobs.invalid';

/** `system+<tenantId>@jobs.invalid` — distinct per tenant, so `emailHash` is too. */
export function systemUserEmail(tenantId: string): string {
    return `system+${tenantId}@${SYSTEM_EMAIL_DOMAIN}`;
}

/**
 * True for an address this module minted.
 *
 * Exported so a consumer can tell a job-authored row from a person's without
 * reading the encrypted column — and so a guard can assert no sign-in path
 * accepts one.
 */
export function isSystemUserEmail(email: string): boolean {
    return email.endsWith(`@${SYSTEM_EMAIL_DOMAIN}`);
}

/**
 * Resolved ids, per tenant, for the process lifetime.
 *
 * Safe to cache indefinitely: the row is never deleted by any path in this
 * repo (it holds no personal data, so the erasure registry does not reach it)
 * and its id never changes. A cold process pays one indexed lookup per tenant.
 */
const cache = new Map<string, string>();

/**
 * The system user's id for `tenantId`, creating the row on first use.
 *
 * Call this OUTSIDE any tenant transaction — see the module docblock.
 */
export async function resolveSystemUserId(tenantId: string): Promise<string> {
    const hit = cache.get(tenantId);
    if (hit) return hit;

    const email = systemUserEmail(tenantId);
    /*
     * CANDIDATES, not `hashForLookup` — and this is a correctness fix the
     * `lookup-hash-call-sites-registered` guard caught before it shipped.
     *
     * The hash is computed rather than matched on `email` because that column
     * is `@map("emailEncrypted")` — ciphertext at rest, so equality on it
     * would compare envelopes. But a READ keyed on the PRIMARY hash alone is
     * `read-primary-only`, which that guard classes as unsafe and whose
     * conversion list has reached empty: during a `LOOKUP_HMAC_KEY` rotation
     * the row exists under the PREVIOUS key, the primary hash matches nothing,
     * and a miss here is not a benign empty result — it falls through to the
     * create below and violates `emailHash`'s `@unique`.
     *
     * Widening the query is the only way to express "either key", which is
     * why this returns a list. One element in the steady state, so the common
     * path is unchanged.
     */
    const candidates = hashForLookupCandidates(email);

    const existing = await prisma.user.findFirst({
        where: { emailHash: { in: candidates } },
        select: { id: true },
    });
    if (existing) {
        cache.set(tenantId, existing.id);
        return existing.id;
    }

    /*
     * `passwordHash` and `emailVerified` are left NULL, which is what makes
     * the account unusable as a credential: the credentials provider needs a
     * hash, and the address cannot receive a verification mail. `emailHash` is
     * NOT passed — `pii-middleware` derives it from `email` on this write, and
     * passing it explicitly would be dead code the middleware overwrites
     * (the mistake #2729's sibling erasure work already made once).
     */
    const created = await prisma.user.create({
        data: { email, name: 'Automated task' },
        select: { id: true },
    });

    logger.info('system-user.created', {
        component: 'system-user',
        tenantId,
        userId: created.id,
    });

    cache.set(tenantId, created.id);
    return created.id;
}

/** Test seam: drop the memo so a suite can observe the create path twice. */
export function __resetSystemUserCache(): void {
    cache.clear();
}
