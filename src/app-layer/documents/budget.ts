/**
 * The per-tenant «Документи» byte ceiling (#2495 Decision 3).
 *
 * A SUM, not a row count, so it follows `ai_tokens` rather than
 * `assertWithinLimit`: its own assert at the upload boundary, exactly as
 * `assertAiBudget` does one directory over, because `getCurrentCount` answers
 * "how many rows" and the question here is "how many bytes".
 *
 * ## Why an env var rather than a plan limit
 *
 * `PLAN_LIMITS` would have shipped, passed CI and enforced NOTHING.
 * `STRIPE_SECRET_KEY` is absent on the VM, so `BILLING_MODE` is `SELFHOSTED`,
 * every tenant resolves to `ENTERPRISE`, and every ENTERPRISE limit is null.
 * What needs protecting is the disk, not revenue: `STORAGE_PROVIDER` is
 * `local`, the volume is on the boot disk, and that disk is shared with
 * playerz production and playerz-staging.
 *
 * ## Why the default lives HERE and not in `env.ts`
 *
 * `jest.setup.js` sets `SKIP_ENV_VALIDATION=1`, under which `@t3-oss/env`
 * skips zod entirely — no validation and NO DEFAULTS — so a `.default()` in
 * `env.ts` is inert in every test and the variable reads `undefined` (#2518).
 * A refusal threshold whose value exists only in production is a refusal no
 * test can exercise, and the refusal is the whole feature. So `env.ts`
 * declares it `.optional()` — the shape `FILE_MAX_SIZE_BYTES` already uses —
 * and this module owns the number, which also keeps the figure next to the
 * reasoning for it.
 */
import { env } from '@/env';
import { codedForbidden } from '@/lib/errors/types';

/**
 * 2 GiB per tenant. Owner ruling 2026-10-31.
 *
 * The disk, measured on the VM on 2026-10-31:
 *
 *     /dev/sda1   79G total   41G used   35G available   54%
 *
 * That single root is agrent's ONLY real filesystem, `/var/lib/docker` is 12G
 * of it, and it is shared with playerz production and playerz-staging. So at
 * ~3 tenants the worst case is ~6 GiB against 35 GB available.
 *
 * CORRECTION, recorded because the wrong figure is the one a future raise
 * would be sized against: this comment first read "130 GB free of 366 GB
 * (63% used)", which is THIS DEV WORKSTATION and not the VM — I ran `df -h /`
 * in the local checkout and credited the answer to production. No 366 GB disk
 * exists in the project at all (`gcloud compute disks list`: agrent 80,
 * inflect-compliance 100, openshell-gateway 20). The original "36 GB free" in
 * #2495 was right, and the "re-measurement" that superseded it inverted the
 * headroom by ~4x in the direction that matters. Caught by the other session,
 * which had hit the same bad note earlier the same night.
 *
 * The ceiling itself does not change — 2 GiB was the owner's answer and
 * ~6 GiB against 35 GB is still comfortable — but read `df` ON THE VM before
 * raising it.
 *
 * Raising it is an env change and a restart, not a migration. Lowering it is
 * free; raising it past the disk is the direction that costs something, which
 * is why `/api/readyz` reports the total — a full disk on this host does not
 * present as a full disk, it presents as Next failing to write `.next` and
 * pages 500ing, so growth has to be watched rather than discovered.
 */
export const DEFAULT_DOCUMENT_STORAGE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

/** The ceiling in force, env override first. */
export function documentStorageLimitBytes(): number {
    const configured = env.DOCUMENT_STORAGE_LIMIT_BYTES;
    // An explicit 0 is not a usable ceiling — it would refuse the very first
    // upload — and the zod schema already refuses non-positive values WHERE IT
    // RUNS. It does not run under test, so the check is repeated here rather
    // than assumed: that asymmetry is exactly #2518.
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
        return configured;
    }
    return DEFAULT_DOCUMENT_STORAGE_LIMIT_BYTES;
}

export interface DocumentStorageUsage {
    usedBytes: number;
    limitBytes: number;
}

/**
 * Refuse an upload that would take the farm past its ceiling.
 *
 * `incomingBytes` is INCLUDED in the comparison, so the refusal happens before
 * the bytes land rather than after the file that broke the limit is already on
 * disk. That ordering is the entire point of a disk ceiling: a check that runs
 * afterwards reports a state it permitted.
 *
 * `usedBytes` is supplied by the caller rather than queried here, which keeps
 * this module pure and — more usefully — lets the settings GET report the SAME
 * two numbers the refusal uses. Two ways of computing "how full is this farm"
 * is how a console tells a farmer they have room while the upload refuses them.
 */
export function assertDocumentStorageBudget(
    usedBytes: number,
    incomingBytes: number,
): DocumentStorageUsage {
    const limitBytes = documentStorageLimitBytes();
    if (usedBytes + incomingBytes > limitBytes) {
        throw codedForbidden(
            'DOCUMENT_STORAGE_FULL',
            'This farm has used all of its document storage.',
            {
                // Numbers, not a sentence: the client renders «1,9 GB от 2 GB»
                // itself. `no-server-authored-user-copy` is ratcheting server
                // prose down, and the wording belongs to the client — which
                // also means iOS and the web can phrase it differently without
                // the server choosing for both.
                usedBytes: String(usedBytes),
                limitBytes: String(limitBytes),
                incomingBytes: String(incomingBytes),
            },
        );
    }
    return { usedBytes, limitBytes };
}
