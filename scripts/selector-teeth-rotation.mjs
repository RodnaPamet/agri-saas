/**
 * Which slice of the guard population this week's SCHEDULED selector audit
 * covers — #2678.
 *
 * ## The defect this exists for
 *
 * `selector-teeth-plan` is diff-based. A `schedule` event carries no
 * `github.event.before`, so `BASE` is empty, the partition is empty, and the
 * weekly run audited ZERO guard files while reporting success. That is the
 * empty-selection defect the whole job exists to find, in the job's own
 * trigger.
 *
 * ## Why a rotation rather than a full audit
 *
 * MEASURED before choosing (the issue asked for the cost, not a guess):
 * 886 guard files, 686 carrying an auditable module-level selector, 1,621
 * mutations — so 686 baseline runs plus 1,621 mutated runs, 2,307 jest
 * invocations. At the 44-54s per invocation measured on a developer box
 * (which the job's own "roughly 7 minutes" for three files corroborates) a
 * full audit is ~31 runner-hours, and at `FILES_PER_SHARD: 3` it wants 229
 * shards against the 256-job matrix ceiling the plan step refuses to exceed —
 * 12% of headroom, so ordinary guard growth would break the job outright.
 *
 * A 1/8 rotation is ~86 files, ~29 shards, ~4 runner-hours, and audits every
 * guard within 8 weeks. Owner ruling 2026-11-09.
 *
 * ## What it catches that the diff-based run cannot
 *
 * The plan already selects guards whose INPUT changed, not only guards whose
 * file changed — but same-PR only, and its own comment says so: "an input
 * changed three PRs ago with the guard untouched is missed exactly as
 * completely as before". A rotation is the only thing that ever reaches that
 * residue (#2377).
 *
 * ## Two decisions that look interchangeable and are not
 *
 * **Buckets are keyed on a HASH OF THE PATH, never on position in a sorted
 * list.** A positional slice (`files[i::8]`) shifts membership every time a
 * guard is added or deleted, so a file can be skipped for months or audited
 * twice in a row, and nothing would show it. A path hash is stable under
 * population growth: a file's bucket changes only when its path changes, and
 * a renamed guard arrives in a diff anyway.
 *
 * **The week index counts epoch weeks, never the ISO week number.** `date +%V`
 * cycles 1..53, and 53 is not a multiple of 8, so the sequence jumps at the
 * year boundary and one bucket can be skipped for a whole year. Epoch weeks
 * increase monotonically for ever, so `index % 8` is a clean cycle.
 */

/**
 * How many weeks a full sweep takes. The ONE lever: 4 doubles the weekly cost
 * and halves the latency, 16 the reverse. Changing it re-buckets every file,
 * which costs one uneven cycle and nothing else.
 */
export const ROTATION_BUCKETS = 8;

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * FNV-1a over the path bytes. Chosen for being short enough to re-derive by
 * hand when a reading looks wrong, and for depending on every byte — a
 * cheaper sum would put `.../a-b.test.ts` and `.../b-a.test.ts` in the same
 * bucket, which clusters a whole family of related guards into one week.
 */
export function bucketFor(file, buckets = ROTATION_BUCKETS) {
    let h = 0x811c9dc5;
    for (let i = 0; i < file.length; i++) {
        h ^= file.charCodeAt(i);
        // `Math.imul` keeps it a 32-bit multiply; `h * prime` loses precision
        // past 2^53 and starts returning the same value for different inputs.
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % buckets;
}

/** Epoch weeks. Monotonic, so `% buckets` cycles evenly for ever. */
export function weekIndex(nowMs) {
    return Math.floor(nowMs / MS_PER_WEEK);
}

/**
 * The files this week audits. `weekIdx` is taken rather than read from the
 * clock so a test can step through consecutive weeks — a rotation whose
 * correctness property spans 8 weeks cannot be tested against `Date.now()`.
 */
export function selectSlice(files, weekIdx, buckets = ROTATION_BUCKETS) {
    // `%` is negative for negative input in JS, and a negative week index is
    // reachable from a bad env override. Normalising keeps the selection a
    // real bucket rather than silently empty.
    const want = ((weekIdx % buckets) + buckets) % buckets;
    return files.filter((f) => bucketFor(f, buckets) === want);
}

// ── CLI ────────────────────────────────────────────────────────────────────
// Reads the population on stdin, one path per line, prints this week's slice.
// The POPULATION IS PASSED IN rather than derived here: the pathspecs live in
// ci.yml, where `selector-teeth-audits-every-guard-dir` checks them against
// the repo's declared guard directories, and a second copy in this file would
// be the one that rots.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('selector-teeth-rotation.mjs');
if (invokedDirectly) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const files = String(Buffer.concat(chunks))
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);

    // An override for the weekly run's own tests and for a manual sweep of a
    // specific bucket. Non-numeric is a HARD ERROR, not a fallback to now:
    // a typo'd override that silently audited a different bucket would be
    // indistinguishable from the rotation working.
    const raw = process.env.SELECTOR_TEETH_ROTATION_WEEK;
    let week;
    if (raw === undefined || raw === '') {
        week = weekIndex(Date.now());
    } else if (/^-?\d+$/.test(raw)) {
        week = Number(raw);
    } else {
        process.stderr.write(
            `selector-teeth-rotation: SELECTOR_TEETH_ROTATION_WEEK='${raw}' is not an integer.\n`
            + 'Refusing to fall back to the current week — that would audit a different\n'
            + 'bucket than asked for, and read exactly like success.\n',
        );
        process.exit(1);
    }

    const slice = selectSlice(files, week);
    process.stderr.write(
        `[selector-teeth-rotation] week ${week} -> bucket ${((week % ROTATION_BUCKETS) + ROTATION_BUCKETS) % ROTATION_BUCKETS}`
        + ` of ${ROTATION_BUCKETS}: ${slice.length} of ${files.length} guard file(s)\n`,
    );
    // An EMPTY slice over a non-empty population is a bug, not a quiet week.
    // The plan step would read `total=0` and report a green audit of nothing.
    if (files.length > 0 && slice.length === 0) {
        process.stderr.write(
            'selector-teeth-rotation: the slice is EMPTY over a non-empty population.\n'
            + 'That is a bucketing fault, and reporting it as "nothing to audit" is the\n'
            + 'defect this rotation was built to remove. Failing instead.\n',
        );
        process.exit(1);
    }
    process.stdout.write(slice.join('\n') + (slice.length ? '\n' : ''));
}
