/**
 * Scan model-generated text on its way OUT — #2578.
 *
 * The assistant answers in prose a model wrote, from tool results it read. Two
 * things could therefore reach a farmer's screen that should not: secret
 * material the model saw and repeated, and secret-shaped material it invented
 * that nonetheless looks like a credential.
 *
 * ## Why this reuses `.secret-patterns` rather than porting a guard
 *
 * The obvious move was porting inflect's AI guard, and it is the wrong size:
 * 1,403 lines across seven files, a per-tenant `aiGuardMode` column this
 * repo's `TenantSecuritySettings` does not have, and two helpers absent here.
 * I called that cheap before measuring it.
 *
 * `.secret-patterns` is already this repo's single source of truth for secret
 * detection — the pre-commit hook and the C.2 guardrail both load it, and
 * `codebase-hygiene-integrity` keeps it honest. Reusing an existing authority
 * beats maintaining a parallel one, and a pattern added for the hook protects
 * this path for free.
 *
 * ## RULE NAMES ONLY, never the match
 *
 * `scanEgress` returns the names of the patterns that fired and never the
 * matched text. That is not tidiness: the caller logs this verdict, and a log
 * line carrying the match would put the secret in the log — moving it from one
 * place it should not be to another, with a longer retention. The same rule
 * inflect's guard states for its audit rows.
 *
 * ## What this is NOT
 *
 * Not a prompt-injection guard — that is the INBOUND direction and
 * `sanitize-untrusted.ts` already owns it. Not a privacy sanitiser; personal
 * data in an answer about the farm's own records is the point of the feature.
 * Not a policy engine: there is one posture for every tenant, because a
 * per-tenant mode is what the 1,403 lines are mostly for and nobody has asked
 * for one here.
 */
import { SECRET_PATTERNS } from '@/lib/security/generated/secret-patterns';

export interface EgressVerdict {
    /** True when nothing fired. The caller may send the text. */
    readonly clean: boolean;
    /** Names of the patterns that fired. NEVER the matched text. */
    readonly ruleIds: readonly string[];
}

/**
 * Compiled once at module load, and the throw is deliberate.
 *
 * An empty pattern set makes every scan report `clean`, which is the
 * absence-reads-as-success shape in the one direction that matters: the
 * control would be silently off. The generator refuses to emit an empty set,
 * and this refuses to run against one, so a hand-edited or truncated module
 * fails at import rather than passing every request.
 *
 * No `g` flag anywhere, and none must be added: a global regex carries
 * `lastIndex` between calls, so a module-level instance would skip matches on
 * every second scan and the control would work intermittently.
 */
const COMPILED: readonly { name: string; re: RegExp }[] = (() => {
    if (SECRET_PATTERNS.length === 0) {
        throw new Error(
            'egress-scan: the generated secret-pattern set is EMPTY. Every scan '
                + 'would report clean, so the control would be silently off. Run '
                + '`npm run secret-patterns:generate`.',
        );
    }
    return SECRET_PATTERNS.map((p) => {
        if (p.flags.includes('g')) {
            throw new Error(
                `egress-scan: pattern "${p.name}" carries the g flag. A module-level `
                    + 'global regex keeps lastIndex between calls and would skip matches '
                    + 'on alternate scans.',
            );
        }
        return { name: p.name, re: new RegExp(p.source, p.flags) };
    });
})();

/** How many patterns are live. For a caller that wants to report its denominator. */
export const EGRESS_PATTERN_COUNT = COMPILED.length;

/**
 * Scan outbound text. Does not throw and does not mutate the text — the caller
 * applies the invariant, which for the assistant is: a non-clean verdict
 * DISCARDS the answer and emits `ASSISTANT_EGRESS_REFUSED`.
 *
 * Discarding rather than redacting is deliberate. A redacted answer invites
 * the reader to reconstruct what was removed, and an answer that was partly
 * about a credential is not improved by hiding the credential.
 */
export function scanEgress(text: string): EgressVerdict {
    const ruleIds: string[] = [];
    for (const { name, re } of COMPILED) {
        if (re.test(text)) ruleIds.push(name);
    }
    return { clean: ruleIds.length === 0, ruleIds };
}
