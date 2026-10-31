/**
 * The per-tenant document storage ceiling, and the band `/api/readyz` reports
 * (#2495 step 3).
 *
 * ## Why an env var and not a plan limit
 *
 * The relay asked for "cap the free plan, with more on paid plans", and that
 * mechanism **would have been inert here**. `STRIPE_SECRET_KEY` is absent on
 * the VM, so `BILLING_MODE` is `SELFHOSTED`, so every tenant resolves to
 * `ENTERPRISE`, and every `PLAN_LIMITS.ENTERPRISE` entry is `null`. A
 * plan-based cap would have shipped, passed CI and enforced nothing.
 *
 * What needs protecting is the disk, not revenue. Re-measured on the VM
 * 2026-10-31, as #2495 asks of whoever takes this step: `/dev/sda1` is 79 GB
 * with **35 GB available**, shared with playerz production and
 * playerz-staging, and every upload across every tenant is still 252 KB. At
 * 2 GB per tenant and ~3 tenants the worst case is ≈6 GB against that 35 —
 * which is the arithmetic the owner's 2 GB decision was made on, and it still
 * holds. (A comment on the issue recorded 130 GB free of 366 GB; that is a
 * different machine. agrent's boot disk is 79 GB.)
 *
 * ## The default is a CONSTANT here, not a zod `.default()` — #2518
 *
 * `jest.setup.js` sets `SKIP_ENV_VALIDATION=1`, and `@t3-oss/env` skips zod
 * entirely under that flag: it neither validates nor applies defaults. So a
 * `.default(2 * 1024 ** 3)` in `src/env.ts` would read `undefined` in every
 * test, and the ceiling under test would be whatever the fallback happened to
 * be — measured on `AV_SCAN_MODE`, which declares `strict` and reads
 * `undefined`, making the download gate permissive in all unit tests.
 *
 * A limit that silently differs between test and production is worse than no
 * limit, so the number lives here and the env var OVERRIDES it. The value is
 * then well-defined whether or not validation ran.
 */
import { env } from '@/env';

/** 2 GB. The owner's decision on #2495, argued from 35 GB of free disk. */
export const DEFAULT_DOCUMENT_STORAGE_LIMIT_BYTES = 2 * 1024 ** 3;

/**
 * The ceiling in force. Reads `DOCUMENT_STORAGE_LIMIT_BYTES` when it is set
 * to a usable positive integer and falls back to the constant otherwise —
 * including when env validation was skipped, which is every test.
 *
 * A zero or negative override is REFUSED rather than honoured. "Set the limit
 * to 0" is indistinguishable from a typo or an unset-but-present variable,
 * and the two readings are opposite: one bricks every upload on the
 * deployment, the other is a mistake somebody would want to find. Falling
 * back is the recoverable direction.
 */
export function documentStorageLimitBytes(): number {
    const raw = env.DOCUMENT_STORAGE_LIMIT_BYTES;
    if (raw == null) return DEFAULT_DOCUMENT_STORAGE_LIMIT_BYTES;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        return DEFAULT_DOCUMENT_STORAGE_LIMIT_BYTES;
    }
    return n;
}

/**
 * The band `/api/readyz` reports instead of a byte count.
 *
 * `/api/readyz` is probed unauthenticated from six GCP regions, so anything
 * on it is effectively public — including roughly how much data the business
 * stores. A threshold crossing is what would prompt an operator to act, and
 * that survives bucketing; the exact figure does not need to be public to get
 * it.
 *
 * The exact `usedBytes` stays on the tenant-scoped settings GET, which is
 * authenticated and scoped to the farm that owns the bytes — a farm learning
 * its own total is not a disclosure.
 */
export type DocumentStorageBand = 'under_1gb' | '1_5gb' | '5_20gb' | 'over_20gb';

const GB = 1024 ** 3;

export function documentStorageBand(totalBytes: number): DocumentStorageBand {
    // Guard first: a negative or non-finite total is a broken read, and
    // reporting it as the SMALLEST band would read as "plenty of room".
    if (!Number.isFinite(totalBytes) || totalBytes < 0) return 'over_20gb';
    if (totalBytes < 1 * GB) return 'under_1gb';
    if (totalBytes < 5 * GB) return '1_5gb';
    if (totalBytes < 20 * GB) return '5_20gb';
    return 'over_20gb';
}
