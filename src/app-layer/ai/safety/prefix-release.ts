/**
 * The cumulative-prefix egress gate — #2670 item 4.
 *
 * Streaming the assistant's answer means sending bytes before the whole answer
 * exists, and `scanEgress` cannot un-send a byte. This is the gate that makes
 * the two compatible.
 *
 * ## The rule
 *
 * Scan ALL text received so far. Release complete sentences only while that
 * cumulative scan is clean. Buffer the trailing partial sentence until it
 * completes.
 *
 * ## Why cumulative and not per-sentence — measured, not assumed
 *
 * A naive per-sentence scan LOSES a class of secret. Of the 14 patterns, the
 * two named-assignment ones — "AWS Secret Access Key (named assignment)" and
 * "Hardcoded Password Assignment" — put `\s*` between the name, the separator
 * and the quoted value, and `\s` admits a NEWLINE. So
 *
 *     secret =
 *     "aaaaaaaaaaaaaaaaaaaa"
 *
 * matches when scanned whole and MISSES when scanned a line at a time. The
 * standalone-token patterns are immune — their bodies are `[A-Za-z0-9_-]`
 * classes that admit no whitespace, so splitting one destroys the match rather
 * than hiding it. A cumulative scan sees both halves and catches it.
 *
 * ## What the guarantee becomes, stated exactly
 *
 * It changes from *"the whole answer was scanned clean"* to **"every byte sent
 * was part of a cumulative scan that came back clean, and no complete pattern
 * match was ever released"**.
 *
 * That is weaker, and the residual is worth naming rather than glossing: a
 * released sentence may contain a PARTIAL token — up to one byte less than a
 * pattern needs to fire — because detection requires the complete token. What
 * cannot happen is a complete match reaching the client, because the scan runs
 * over everything received before anything is released, and the release point
 * is a sentence boundary rather than an arbitrary byte.
 *
 * `prefix-release-is-sound` is the property test over the real pattern set: it
 * injects each pattern's sample at every chunk boundary and asserts no release
 * ever contains a complete match. A new pattern with no declared sample fails
 * it, which is the forcing function — the alternative is a pattern class
 * nobody checked this against.
 *
 * ## Once dirty, always dirty — BY CONSTRUCTION, not by a flag
 *
 * A dirty verdict is terminal: the caller discards the answer and emits
 * `ASSISTANT_EGRESS_REFUSED`, exactly as the non-streaming path does, and
 * nothing further is ever released.
 *
 * That needs no state, and the first version of this file carried a `poisoned`
 * boolean anyway. A mutation deleting it changed no assertion, which is the
 * tell: `cumulative` only ever GROWS, so a re-scan re-detects the same secret
 * and returns the same refusal. The flag was an optimisation wearing the
 * costume of a control — it saved re-running 14 regexes over an answer that is
 * being discarded — and a line that reads as a safety mechanism while
 * asserting nothing is worse than its absence, because the next reader trusts
 * it. Deleted rather than kept with a comment.
 */
import { scanEgress, type EgressVerdict } from './egress-scan';

/**
 * Sentence terminators, plus a hard newline.
 *
 * A newline counts because the model writes lists, and a bullet is a release
 * unit a reader can use even though it carries no full stop. Without it a
 * bulleted answer would stream as one block at the end, which is the thing
 * this exists to avoid.
 */
const BOUNDARY = /[.!?…]["')\]]*\s|\n/g;

export interface ReleaseStep {
    /** Text cleared for sending. Empty when nothing new completed. */
    readonly release: string;
    /** The cumulative verdict. `clean: false` is TERMINAL. */
    readonly verdict: EgressVerdict;
}

export interface PrefixReleaser {
    /** Feed a provider delta. Returns what may now be sent. */
    push(delta: string): ReleaseStep;
    /**
     * Replace the accumulated text with `cumulative` — the ABSOLUTE text so
     * far rather than an increment.
     *
     * This is the shape the routing layer can actually supply, and the reason
     * is PII redaction: an EXTERNAL backend is sent redacted messages and its
     * response is rehydrated AFTER the call, so a raw provider delta carries
     * placeholders. Rehydrating a single delta is unsafe — a placeholder can
     * straddle a delta boundary — while rehydrating the accumulated text is
     * not, because a placeholder is whole within it once it has arrived.
     *
     * It also makes a RETRY self-correcting. `completeWithRouting` retries up
     * to twice on a target before failing over, so a second attempt starts its
     * text again from nothing. A shorter `cumulative` than last time is
     * therefore a RESTART, not a gap: the already-released count is rewound so
     * the same sentences are not released twice, and `restarted` says so for a
     * caller that wants to tell its client to discard what it has.
     */
    observe(cumulative: string): ReleaseStep & { restarted: boolean };
    /** The answer is complete — release whatever is left, if clean. */
    finish(): ReleaseStep;
    /** Everything received so far, for the caller that records the answer. */
    full(): string;
    /** How much has been handed out, so a caller can assert the two agree. */
    releasedLength(): number;
}

/**
 * Find the end of the last complete sentence in `text`, or -1.
 *
 * Returns an index INTO text (exclusive end), so the caller slices
 * `[releasedTo, boundary)`.
 */
function lastBoundary(text: string, from: number): number {
    BOUNDARY.lastIndex = 0;
    let end = -1;
    let m: RegExpExecArray | null;
    while ((m = BOUNDARY.exec(text)) !== null) {
        const candidate = m.index + m[0].length;
        if (candidate > from) end = candidate;
        // A zero-length match would spin; the pattern cannot produce one, but
        // `lastIndex` is advanced defensively because this loop is the one
        // place a bad edit would hang the stream rather than fail a test.
        if (m[0].length === 0) BOUNDARY.lastIndex += 1;
    }
    return end;
}

export function createPrefixReleaser(): PrefixReleaser {
    let cumulative = '';
    let releasedTo = 0;

    const step = (finishing: boolean): ReleaseStep => {
        // Self-poisoning: `cumulative` only grows, so once it contains a
        // match every later scan finds it again and refuses again.
        const verdict = scanEgress(cumulative);
        if (!verdict.clean) return { release: '', verdict };
        const upTo = finishing ? cumulative.length : lastBoundary(cumulative, releasedTo);
        if (upTo <= releasedTo) return { release: '', verdict };
        const release = cumulative.slice(releasedTo, upTo);
        releasedTo = upTo;
        return { release, verdict };
    };

    return {
        push(delta: string): ReleaseStep {
            cumulative += delta;
            return step(false);
        },
        observe(next: string): ReleaseStep & { restarted: boolean } {
            // A shorter text than we already hold cannot be growth, so it is a
            // fresh attempt. Rewinding `releasedTo` is what keeps a retry from
            // re-releasing sentences the client already has — and reporting it
            // lets the caller decide whether to tell the client to discard.
            const restarted = next.length < cumulative.length;
            if (restarted) releasedTo = 0;
            cumulative = next;
            return { ...step(false), restarted };
        },
        finish(): ReleaseStep {
            return step(true);
        },
        full(): string {
            return cumulative;
        },
        releasedLength(): number {
            return releasedTo;
        },
    };
}
