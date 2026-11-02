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
 * `ROLE_SPOOF_PREFIX` is POSITIONAL, and it used to be strictly anchored —
 * so anything occupying the start of the line defeated it, and a single HTML
 * tag was enough: `<p>system: …` passed through untouched. Measured with a
 * positive control, because "not neutralised" and "the function is broken"
 * are otherwise the same reading.
 *
 * **It now skips a leading run of non-letters, so that class is closed at the
 * pattern rather than per caller** — see the pattern's own docblock for the
 * measurement, including why #2698's prescribed strip-then-check is a no-op
 * on one input shape and actively worse on another.
 *
 * `sanitizeUntrustedMarkup` is still the right door for genuine HTML
 * (RSS descriptions), and for a second reason that has not changed: a
 * delimited block should not carry tags into the prompt at all. It is no
 * longer the only thing standing between a tagged role prefix and the model.
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

/**
 * Role-spoofing prefixes at the start of a line (e.g. "system:", "assistant:").
 *
 * ## It skips whitespace and TAGS, and nothing else — the #2698 fix
 *
 * A role marker only impersonates a role when it LEADS, so the check is
 * positional. A strict `^\s*` anchor is defeated by one HTML tag, which is
 * what #2698 is about; the skip closes that at the PATTERN, so every caller
 * is covered at once instead of one call site at a time.
 *
 * The skip has to understand TAGS specifically, because a tag contains
 * LETTERS ("p", "div") — so skipping non-letters alone cannot step over one.
 * It is done by `skipLeadingMarkup` rather than by a regex: see that
 * function for why CodeQL refuses the regex form.
 *
 * **#2698's prescribed remedy — strip markup, then check — is the wrong tool
 * for the call site it left open, and that is why this is a pattern change.**
 * Measured on the advisor's RAG path with `system: <innocuous Bulgarian>` as
 * the payload (the "ignore previous instructions" family is unanchored, so
 * using it as the probe reads identically in both worlds and proves nothing):
 *
 *   `<p>system: …`        the strip is a NO-OP — `chunkHtmlByParagraph`,
 *                         `ingest-tenant`'s `plainText` and the article
 *                         reindex all remove tags upstream already
 *   `&lt;p&gt;system: …`  `sanitizePlainText` decodes entities LAST, so
 *                         stripping first hands the model literal `<p>` it
 *                         did not have — the remedy makes this case WORSE
 *
 * ## What it deliberately does NOT skip, and why the narrow version won
 *
 * An earlier version of this fix also skipped leading punctuation, catching
 * `• system: …`, `"system: …`, `- system: …` and `> system: …`. It was
 * withdrawn after agrent backend-1 pointed at the population it would damage,
 * and the measurement agreed: a knowledge article QUOTING a config block —
 *
 *     irrigation:
 *       system: drip
 *       tool: boom-sprayer
 *
 * — is where these four English words actually occur in a Bulgarian agronomy
 * corpus. So the false-positive population is nearly identical to the
 * population where a false positive HURTS: a farmer reading a mangled
 * `[role] drip` about the sprayer setting they are trying to change. The
 * punctuation skip additionally matched a markdown table row
 * (`| tool: … |`), a dash-led spec line and a CSV fragment. Measured, all
 * three were introduced by the widening; this narrow form introduces none.
 *
 * Two residual gaps, recorded because a silent omission teaches nothing:
 *
 *   · A punctuation-led role prefix (`• system: …`) stays masked. It is
 *     defence in depth here, not the only control — the block is delimited
 *     and the system prompt says it is data — and missing it costs less than
 *     mangling a legitimate technical line.
 *   · `&lt;p&gt;system: …` stays masked under EVERY form above, this one
 *     included. Entity-escaped markup needs a decode, and a decode is what
 *     cannot be applied twice.
 *   · A CYRILLIC role word («Асистент:») matches nothing. These four are the
 *     provider contract's own literals, and a Bulgarian word is not a role
 *     marker any provider honours, so defanging it would be theatre. A list
 *     change, not a pattern change.
 *
 * ## One false positive is PRE-EXISTING, and this does not fix it
 *
 * `  system: drip` and `developer: Netafim` match the STRICT anchor too — the
 * old `^\s*` already skipped indentation. So the config-block damage above
 * shipped long before this change and is untouched by it. **#2730** holds it,
 * with the five options and why none is obviously right: narrowing the role
 * list or demanding non-key-value context is a product decision about what
 * this corpus contains, not a fix to where the check starts looking.
 *
 * The test asserting that damage is deliberate, so #2730 has a line to flip
 * rather than a surprise to discover.
 */
const ROLE_SPOOF_PREFIX = /^(system|assistant|developer|tool)\s*:/i;

/** The longest a tag-like group may be for the skip to step over it. */
const MAX_SKIPPABLE_TAG = 40;

/**
 * Index of the first character that is neither whitespace nor a tag-like
 * group — i.e. where the role check should start looking.
 *
 * ## Why this is a loop and not a regex
 *
 * The obvious form is `/^(?:\s|<[^>]{0,40}>)*(system|…)\s*:/`, and it works.
 * CodeQL rejected it as a high-severity finding on the pull request, and it is
 * right to: a bounded quantifier nested inside a star is the polynomial-ReDoS
 * shape, and this function's input is untrusted text from an RSS feed or a
 * tenant's own document — the exact "uncontrolled data" the rule is about.
 * Rewriting the regex smaller would be arguing with the rule; removing the
 * backtracking answers it.
 *
 * This scan is unambiguously linear. Each iteration either advances `i` or
 * breaks, and the one `indexOf` that could scan far runs at most ONCE, because
 * a `<` with no matching `>` within the bound ends the loop.
 */
function skipLeadingMarkup(line: string): number {
    let i = 0;
    while (i < line.length) {
        const ch = line[i] as string;
        if (ch === ' ' || ch === '\t' || /\s/.test(ch)) {
            i += 1;
            continue;
        }
        if (ch === '<') {
            const close = line.indexOf('>', i + 1);
            // `close - i <= MAX_SKIPPABLE_TAG + 1` keeps the same bound the
            // regex form carried: a very long `<…>` is content, not markup.
            if (close !== -1 && close - i <= MAX_SKIPPABLE_TAG + 1) {
                i = close + 1;
                continue;
            }
        }
        break;
    }
    return i;
}

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
            // Look PAST leading whitespace and markup — see
            // `skipLeadingMarkup`. A role marker only impersonates a role
            // when it leads, and one HTML tag used to be enough to hide it.
            const rest = line.slice(skipLeadingMarkup(line));
            if (ROLE_SPOOF_PREFIX.test(rest)) {
                // Defang the role prefix so it reads as plain text. The
                // skipped prefix is dropped with it: a tag or indentation in
                // front of a neutralised marker is not worth preserving.
                return rest.replace(ROLE_SPOOF_PREFIX, '[role] ');
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
