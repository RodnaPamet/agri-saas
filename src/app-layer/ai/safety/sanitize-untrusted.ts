import { sanitizePlainText } from '@/lib/security/sanitize';

/**
 * Untrusted-content sanitiser for the advisory prompt (feat/ai-evals-safety).
 *
 * Retrieved RAG chunks AND tenant free-text are UNTRUSTED — they can carry
 * prompt-injection ("ignore previous instructions", a forged "system:"
 * line, role-spoofing). The PRIMARY defences are elsewhere (delimiting the
 * untrusted block in the prompt, Zod-validating the model output, and the
 * fact that dosage numbers come from structured data not free text). This
 * is a belt-and-suspenders pre-filter that neutralises the most obvious
 * injection markers BEFORE they enter the prompt so they can't even be
 * read as instructions.
 *
 * It NEVER eval/exec's anything and never follows the content — it only
 * rewrites known injection-shaped lines into an inert, labelled form.
 */

/*
 * ONE anchored pattern among several unanchored ones, and that asymmetry is a
 * trap (#2698).
 *
 * `INJECTION_LINE_PATTERNS` are all `\b`-bounded and UNANCHORED, so markup
 * around them changes nothing — `<p>ignore all previous instructions</p>` is
 * neutralised exactly as the bare line is. Measured.
 *
 * `ROLE_SPOOF_PREFIX` is ANCHORED at the start of the line. So anything
 * occupying that position defeats it, and a single HTML tag is enough:
 * `<p>system: …` passes through untouched. Also measured, with a positive
 * control, because "not neutralised" and "the function is broken" are
 * otherwise the same reading.
 *
 * That makes the order of operations load-bearing for any caller whose input
 * may carry markup — see `sanitizeUntrustedMarkup` below, which is the only
 * safe way to feed one of those in.
 */

/** Patterns that look like an attempt to override the system instructions. */
const INJECTION_LINE_PATTERNS: RegExp[] = [
    /\bignore (?:all )?(?:the )?(?:previous|prior|above|preceding) (?:instructions?|prompts?|rules?)\b/i,
    /\bdisregard (?:all )?(?:the )?(?:previous|prior|above) (?:instructions?|rules?)\b/i,
    /\bforget (?:everything|all) (?:above|before|previous)\b/i,
    /\boverride (?:the )?(?:system|previous) (?:prompt|instructions?)\b/i,
    /\byou are now\b/i,
    /\bnew instructions?:\b/i,
];

/** Role-spoofing prefixes at the start of a line (e.g. "system:", "assistant:"). */
const ROLE_SPOOF_PREFIX = /^\s*(system|assistant|developer|tool)\s*:/i;

/**
 * Replacement marker for a neutralised line — visible to the model as
 * data, never as an instruction.
 */
const NEUTRALISED = '[removed: untrusted directive]';

/**
 * Sanitise a single untrusted text blob. Strips/escapes obvious injection
 * markers line-by-line; leaves ordinary agronomic content untouched.
 */
export function sanitizeUntrusted(text: string): string {
    if (!text) return '';
    return text
        .split(/\r?\n/)
        .map((line) => {
            if (INJECTION_LINE_PATTERNS.some((p) => p.test(line))) return NEUTRALISED;
            if (ROLE_SPOOF_PREFIX.test(line)) {
                // Defang the role prefix so it reads as plain text.
                return line.replace(ROLE_SPOOF_PREFIX, '[role] ');
            }
            return line;
        })
        .join('\n');
}

/**
 * `sanitizeUntrusted` for input that may carry MARKUP — RSS bodies, scraped
 * HTML, anything an external author wrote (#2698).
 *
 * ## Why this exists rather than a note telling callers to strip first
 *
 * The role-spoof pattern is anchored, so a leading tag masks it. Which means a
 * caller has exactly two orders available and they fail in opposite
 * directions:
 *
 *   · strip, THEN check — the prefix is unmasked for the CHECK, and defanged.
 *   · check, THEN strip — the prefix is unmasked for the MODEL, after the
 *     check has already passed on text where it was invisible.
 *
 * Same two functions, opposite outcomes, and neither errors. A convention
 * documented at eight call sites is a convention that will be got wrong at the
 * ninth, so the order is encoded in a NAME instead.
 *
 * ## Why not strip inside `sanitizeUntrusted` itself
 *
 * It would fix every caller at once, and it is the wrong shape here for a
 * specific reason: `sanitizePlainText` is NOT idempotent. It decodes entities
 * LAST, so `&amp;lt;` becomes `&lt;` on one pass and `<` on two. A caller that
 * already strips — and #2694 adds one — would then corrupt any text containing
 * an escaped entity. One application per value, at the point the value enters
 * the prompt.
 */
export function sanitizeUntrustedMarkup(text: string): string {
    // STRIP FIRST. See the note above: the other order defangs nothing and
    // hands the model a clean role prefix.
    return sanitizeUntrusted(sanitizePlainText(text));
}
