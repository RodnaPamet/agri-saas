/**
 * The bucket `/api/readyz` reports for document storage (#2495 step 3).
 *
 * The CEILING itself lives in `@/app-layer/documents/budget` — this module is
 * only the bucketing, and the split is deliberate: a ceiling is a refusal
 * threshold read by one usecase, while a band is a public reading on an
 * endpoint probed unauthenticated from six regions every 60 seconds.
 *
 * ## Why a band rather than the total
 *
 * Anything `/api/readyz` returns is effectively public. The exact number of
 * bytes the business stores is not an operational signal that needs to be —
 * what an operator acts on is a THRESHOLD CROSSING, and a bucket preserves
 * exactly that while disclosing nothing finer. The precise figure stays on the
 * tenant-scoped settings GET, which is authenticated and scoped to the farm
 * that owns the bytes.
 *
 * ## Why the bands are where they are
 *
 * Sized against the disk rather than against the ceiling. Measured on the VM
 * 2026-10-31: `/dev/sda1` is 79 GB with **35 GB available**, 54% used, and
 * that root is shared with playerz production and playerz-staging. So the
 * interesting thresholds are low — 1 GB is "the feature is being used", 5 GB
 * is "worth watching", 20 GB is "this is now a material fraction of a disk
 * three products share".
 *
 * (A note on #2495 recorded 130 GB free of 366 GB. That is a development
 * workstation, not the VM; no 366 GB disk exists in the project. Read `df` ON
 * THE VM before re-sizing these.)
 *
 * ## A broken read is the LARGEST band, never the smallest
 *
 * `documentStorageBand` is handed a number by a caller that may have failed to
 * read one. Reporting a negative or non-finite total as `under_1gb` would say
 * "plenty of room" about a measurement that did not happen — wrong in the
 * reassuring direction. The capability above this has an `unknown` state for
 * the case it can detect; this guard is for the case it cannot.
 */

export type DocumentStorageBand = 'under_1gb' | '1_5gb' | '5_20gb' | 'over_20gb';

const GB = 1024 ** 3;

export function documentStorageBand(totalBytes: number): DocumentStorageBand {
    // Guard first: a negative or non-finite total is a broken read, and
    // reporting it as the SMALLEST band would read as "plenty of room".
    if (!Number.isFinite(totalBytes) || totalBytes < 0) return 'over_20gb';
    // A boundary belongs to the HIGHER band: a farm exactly at a threshold has
    // crossed it, and the quieter answer on the exact value an operator set an
    // expectation against is the wrong one.
    if (totalBytes < 1 * GB) return 'under_1gb';
    if (totalBytes < 5 * GB) return '1_5gb';
    if (totalBytes < 20 * GB) return '5_20gb';
    return 'over_20gb';
}
