/**
 * Guard: `coded*()`'s message argument is never the code repeated (#1677).
 *
 * ## What shipped, and for how long
 *
 *     throw codedNotFound('ACCOUNT_ALREADY_ERASED', 'ACCOUNT_ALREADY_ERASED');
 *
 * Eight sites across five codes, all account-lifecycle. #1677 counted them and
 * explained why they exist: the bare code is the PHONE-safe value, because a
 * token fails the phone's `isHumanSentence` test and degrades to generic
 * Bulgarian, where an English sentence degrades to English. That reasoning was
 * correct when it was written.
 *
 * It is no longer the trade it describes. `localizeErrorPayload` now replaces
 * `message` with the catalogue's sentence for the code, per request locale, on
 * the universal error path (`lib/errors/api.ts`) — #1677's own option 3 — and
 * #1918 took the catalogue to 234 of 239 codes. So the code never needs to
 * carry the degradation: the server resolves the sentence before either client
 * sees it.
 *
 * ## Why the remaining literal still matters
 *
 * `localizeErrorPayload` SWALLOWS its own failures, deliberately — "an error
 * handler that throws turns a 403 into a 500: the refusal is lost to the
 * attempt to explain why it could not be translated". So on any localisation
 * miss the original `message` is what ships, and that path has no test looking
 * at it and no alarm when it fires.
 *
 * A token is the worst thing to leave there. `ACCOUNT_SUSPENDED` on screen
 * tells a farmer nothing and tells a support agent only that something went
 * wrong twice.
 *
 * ## What this does NOT claim
 *
 * That every message is good copy. It checks one mechanical property — the
 * second argument is not the first repeated — which is the shape #1677
 * measured. A vague sentence passes, and should: wording is a review question,
 * not a guard's.
 */
import { readFileSync } from 'node:fs';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/** `coded<Anything>('CODE', 'message'` — the two leading string literals. */
const CODED_CALL = /coded[A-Za-z]*\(\s*'([A-Z][A-Z0-9_]{3,})'\s*,\s*'([^']*)'/g;

interface Site {
    file: string;
    code: string;
}

function scan(): { calls: number; bare: Site[] } {
    const files = collectSourceFiles({ roots: ['src'], extensions: ['.ts', '.tsx'], floor: 500 });
    const bare: Site[] = [];
    let calls = 0;
    for (const abs of files) {
        const raw = readFileSync(abs, 'utf8');
        if (!raw.includes('coded')) continue;
        // Comments blanked (#1774): this file's own docblock quotes the
        // defective call, and an unblanked scan would report the guard.
        const code = blankNonCode(raw);
        for (const m of code.matchAll(CODED_CALL)) {
            calls++;
            if (m[1] === m[2]) bare.push({ file: abs.slice(REPO_ROOT.length + 1), code: m[1] });
        }
    }
    return { calls, bare };
}

describe('a coded message is not its own code (#1677)', () => {
    const { calls, bare } = scan();

    it('ranges over the real population — the denominator', () => {
        console.log(
            `[coded-message] ${calls} coded*() call(s) with a literal code and message; ${bare.length} pass the code as the message`,
        );
        // #1677 measured 138 literal-message sites. The figure has grown with
        // the codebase; a floor well below it separates "none are bare" from
        // "none were examined", which is the failure this guard would
        // otherwise have.
        expect(calls).toBeGreaterThan(100);
    });

    it('detects the shape, and accepts a real sentence — the control', () => {
        const check = (src: string) => {
            const m = [...src.matchAll(CODED_CALL)][0];
            return m ? m[1] === m[2] : null;
        };
        expect(check("throw codedForbidden('ACCOUNT_SUSPENDED', 'ACCOUNT_SUSPENDED');")).toBe(true);
        expect(check("throw codedForbidden('ACCOUNT_SUSPENDED', 'Your account is suspended.');")).toBe(false);
        // And a message that merely MENTIONS a code is not the same thing —
        // the test for the detector, not for the codebase.
        expect(check("throw codedBadRequest('X_FAILED', 'X_FAILED is not a valid value.');")).toBe(false);
    });

    it('no call site passes its code as its message', () => {
        expect(
            bare.map((s) => `  ${s.file}: coded…('${s.code}', '${s.code}')`).join('\n'),
        ).toBe('');
    });
});
