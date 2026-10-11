/**
 * The failure STAMP — how a coded job failure reaches a poll route (#1447).
 *
 * BullMQ persists one thing about a failure: `err.message`, as
 * `failedReason`. A client that wants to say «Файлът е твърде голям» rather
 * than render «File is too large» needs a code, and there is no field for
 * one — so the worker writes it into `job.data`, which the poll routes
 * already read for their tenant pin.
 *
 * The key name lives here and nowhere else. It is written in `worker.ts`
 * and read in two route files; a string literal in three places is how
 * this kind of thing silently stops working.
 */
import type { ErrorParams } from '@/lib/errors/types';

/** The reserved key the worker adds to `job.data` on a coded failure. */
export const JOB_FAILURE_STAMP_KEY = 'failure';

/** What the worker writes under that key. */
export interface JobFailureStamp {
    code: string;
    params?: ErrorParams;
}

/** What a poll route puts on the wire. */
export interface PolledFailure {
    failedCode: string | null;
    failedParams: ErrorParams | null;
}

/**
 * `job.data` with the stamp added — the worker's writer.
 *
 * Spreads rather than replaces: `job.data` IS the job payload, and losing
 * it would break the tenant pin the poll routes depend on, turning every
 * subsequent poll into a 404.
 */
export function withFailureStamp(
    jobData: unknown,
    stamp: JobFailureStamp,
): Record<string, unknown> {
    const base = typeof jobData === 'object' && jobData !== null
        ? (jobData as Record<string, unknown>)
        : {};
    return { ...base, [JOB_FAILURE_STAMP_KEY]: stamp };
}

/**
 * The stamp, for a job in state `state` — the poll route's reader.
 *
 * **Gated on `state === 'failed'`** and that is the whole subtlety. Most
 * import jobs are `attempts: 1`, but the worker's processor is shared by
 * every job name and some do retry: a job that fails attempt 1 with a code
 * and succeeds on attempt 2 leaves the stamp behind in `job.data`. Reading
 * it unconditionally would hand a client a failure code for a job that
 * completed. The code describes the terminal state or it is not published.
 */
export function readFailureStamp(jobData: unknown, state: string): PolledFailure {
    if (state !== 'failed') return { failedCode: null, failedParams: null };
    if (typeof jobData !== 'object' || jobData === null) {
        return { failedCode: null, failedParams: null };
    }
    const stamp = (jobData as Record<string, unknown>)[JOB_FAILURE_STAMP_KEY];
    if (typeof stamp !== 'object' || stamp === null) {
        return { failedCode: null, failedParams: null };
    }
    const { code, params } = stamp as { code?: unknown; params?: unknown };
    // No code means no params either. `failedParams` exists to be interpolated
    // into the sentence `failedCode` selects; publishing values with nothing
    // to put them in gives a client numbers it cannot place, and it is a
    // shape the worker never writes — so reading it back is corruption, not a
    // case to pass through.
    if (typeof code !== 'string') return { failedCode: null, failedParams: null };
    return {
        failedCode: code,
        // Scalars only, matching `ErrorParams`. A stamp is written by our own
        // worker, but it round-trips through Redis as JSON, so the shape is
        // re-checked rather than asserted.
        failedParams: isErrorParams(params) ? params : null,
    };
}

function isErrorParams(value: unknown): value is ErrorParams {
    if (typeof value !== 'object' || value === null) return false;
    return Object.values(value as Record<string, unknown>).every(
        (v) => typeof v === 'string' || typeof v === 'number',
    );
}
