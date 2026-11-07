/**
 * Catch a ciphertext ENVELOPE on its way out of the API — #2723 item 2.
 *
 * ## The defect class
 *
 * Tenant-keyed encrypted columns decrypt through a Prisma client extension
 * whose DEK comes from the ALS audit context, not from the row — it needs the
 * key before the row arrives, so it cannot read `row.tenantId`. With no tenant
 * bound, `resolveTenantDekPair` returns `NO_DEK_PAIR` and the extension passes
 * the CIPHERTEXT through. No error, no log, a populated-looking row whose
 * string is an envelope.
 *
 * Every test over the three readers that shipped this was green, because they
 * all mocked Prisma — and a double hands back whatever string it was given, so
 * plaintext and ciphertext are the same observation. A mock cannot report an
 * ENCODING at all.
 *
 * ## Why at the response and not at the read
 *
 * #2722 fixed three readers and added `readableOrNull`, a per-SITE check. That
 * is right where it is applied and says nothing about the next site. A static
 * scan cannot close the gap either: the DEK comes from ALS, so whether a read
 * through the global client resolves a tenant depends on whether it happens to
 * run inside `runInTenantContext` — a reachability question a regex cannot
 * answer. An envelope reaching a RESPONSE, by contrast, is always a defect
 * whatever the cause, and needs no reachability analysis.
 *
 * ## It WATCHES; it does not redact
 *
 * Deliberate, and the opposite call from `readableOrNull`. That helper returns
 * `null` at a site where its author knows the field is nullable. This runs over
 * an arbitrary payload and knows nothing about the shape, and nulling a
 * NON-nullable field turns one garbled string into a decode failure for the
 * whole response — which is strictly worse for a client, and is exactly the
 * bug class agrent-ios#550 exists for. So the detector makes the silence loud
 * and leaves the fix at the site.
 *
 * ## Precision, which is the whole risk
 *
 * The matcher is anchored at BOTH ends, restricted to the base64 alphabet, and
 * floored at the shortest envelope the producer can emit. `encryptWithKey`
 * returns `'v2:' + base64(iv ‖ ciphertext ‖ tag)` with a 12-byte IV and a
 * 16-byte tag, so even an empty plaintext is 28 bytes — 40 base64 characters,
 * a 43-character string.
 *
 * That floor is what makes this safe to run over a farmer's free text. A note
 * beginning «v2: план за пръскане» does not match: it has a space, it is
 * Cyrillic, and it is short. `ENVELOPE_MIN_B64` is asserted against the REAL
 * `encryptWithKey` output in the tests rather than against this comment, so the
 * matcher cannot drift from its producer.
 */

import { logger } from '@/lib/observability/logger';
import { recordCiphertextEgress } from '@/lib/observability/metrics';

/**
 * Shortest base64 body the producer can emit: ceil((12 + 0 + 16) / 3) * 4.
 * Written as the arithmetic rather than `40` so a change to either constant
 * reads as a change here too.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const ENVELOPE_MIN_B64 = Math.ceil((IV_BYTES + TAG_BYTES) / 3) * 4;

/**
 * Anchored and base64-STRUCTURED, not merely base64-alphabet.
 *
 * The first version of this was `[A-Za-z0-9+/]{38,}={0,2}`, and the floor was
 * DECORATIVE: 39 alphabet characters satisfy `{38,}` with `={0,2}` matching
 * empty, so `v2:` + 39 characters passed — a string no producer can emit,
 * since base64 comes in blocks of 4. Caught by the test that takes a real
 * envelope and shortens it by one.
 *
 * So: whole 4-character blocks, with the one legal padded tail, and the total
 * floored at what an empty plaintext produces.
 */
const ENVELOPE_RE = /^v[12]:(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The cheap pre-filter: no allocation, and true for almost no real payload. */
const ENVELOPE_NEEDLE_V1 = '"v1:';
const ENVELOPE_NEEDLE_V2 = '"v2:';

/** Does this value look like something our own encryption produced? */
export function isCiphertextEnvelope(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const body = value.length - 'v2:'.length;
    // Length first: it is the cheap half, and it is what makes this safe to run
    // over free text. A base64 body is a multiple of 4 and at least as long as
    // an empty plaintext's.
    if (body < ENVELOPE_MIN_B64 || body % 4 !== 0) return false;
    return ENVELOPE_RE.test(value);
}

/** What a scan found, and whether it got to look at everything. */
export interface CiphertextScan {
    paths: string[];
    /** A cap stopped the walk — so `paths` may be incomplete. */
    truncated: boolean;
}

/** Cap the walk so a pathological payload cannot make this the slow part. */
const MAX_PATHS = 10;
const MAX_NODES = 50_000;
/** Deeper than any real API payload, shallow enough not to risk the stack. */
const MAX_DEPTH = 40;

/**
 * JSON paths of every envelope in `payload`, never the values.
 *
 * The path is the diagnostic — it names the field that shipped ciphertext, so
 * the fix has an address. The value is content under an envelope we could not
 * open, and the envelope is not the useful part.
 */
export function findCiphertextPaths(payload: unknown): CiphertextScan {
    const found: string[] = [];
    let nodes = 0;
    /**
     * Whether a cap cut the walk short. Without this an empty `paths` means
     * EITHER "this payload is clean" OR "I gave up before looking at all of
     * it", and those are different facts — the second is the one that reads as
     * success while the detector is blind. Reported on the log line.
     */
    let truncated = false;
    /**
     * There was a `WeakSet` cycle guard here and it is deliberately GONE.
     *
     * The property that matters is that a self-referential payload cannot kill
     * the walk — the first version had neither guard and died with `RangeError:
     * Maximum call stack size exceeded`, which `reportCiphertextEgress` would
     * have swallowed, leaving the detector permanently blind on that route with
     * no signal at all.
     *
     * Measured, though: with BOTH a WeakSet and the depth cap in place,
     * removing either one alone still passed every test, and only removing both
     * failed. So the WeakSet was a control nothing could detect. `MAX_DEPTH`
     * carries the cycle case (it truncates at 40) and `MAX_NODES` bounds the
     * fan-out, and each now has a test that distinguishes it — a deep ACYCLIC
     * payload for the former, which no WeakSet would have saved. Keeping a
     * second guard for the same property, with no test able to tell it apart,
     * is how a codebase accumulates controls that only look like safety.
     */
    const walk = (node: unknown, path: string, depth: number): void => {
        if (found.length >= MAX_PATHS || nodes >= MAX_NODES || depth > MAX_DEPTH) {
            truncated = true;
            return;
        }
        nodes += 1;
        if (typeof node === 'string') {
            if (isCiphertextEnvelope(node)) found.push(path || '$');
            return;
        }
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i += 1) {
                walk(node[i], `${path}[${i}]`, depth + 1);
            }
            return;
        }
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            walk(v, path ? `${path}.${k}` : k, depth + 1);
        }
    };

    walk(payload, '', 0);
    return { paths: found, truncated };
}

/**
 * Inspect an outgoing API response. Never throws, never consumes the body.
 *
 * Shape of the cost: a `clone()` plus one `text()` per JSON response, then a
 * substring scan. The expensive half — `JSON.parse` and the path walk — runs
 * only when the scan hits, which in a healthy deployment is never. A detector
 * that made every response pay for a parse would be its own regression.
 */
export async function reportCiphertextEgress(
    response: Response,
    route: string,
): Promise<void> {
    try {
        const type = response.headers.get('content-type') || '';
        if (!type.includes('application/json')) return;
        // 204 and friends have no body to read.
        if (response.status === 204 || response.status === 304) return;

        const text = await response.clone().text();
        if (!text.includes(ENVELOPE_NEEDLE_V2) && !text.includes(ENVELOPE_NEEDLE_V1)) {
            return;
        }

        let scan: CiphertextScan;
        try {
            scan = findCiphertextPaths(JSON.parse(text));
        } catch {
            // Unparseable but needle-bearing: report the route without paths
            // rather than nothing. "I could not look" and "nothing there" must
            // not be the same observation.
            scan = { paths: ['<unparseable>'], truncated: true };
        }
        if (scan.paths.length === 0) return;

        recordCiphertextEgress({ route });
        logger.error('encryption.ciphertext_reached_response', {
            component: 'ciphertext-egress',
            route,
            status: response.status,
            // PATHS only. Never the value, and never the whole body.
            paths: scan.paths,
            // From the WALK, not inferred from `paths.length`: a node or depth
            // cap truncates without filling the path list, so deriving this
            // from the length would report a blind scan as a complete one.
            truncated: scan.truncated,
        });
    } catch {
        // A detector must not be able to break a response that was working.
    }
}
