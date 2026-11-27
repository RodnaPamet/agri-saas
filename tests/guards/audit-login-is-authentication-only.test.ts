/**
 * `operation: 'login'` is emitted by AUTHENTICATION code and nothing else
 * (#3285).
 *
 * `downloadEvidenceFile` audited an evidence file download as
 * `category: 'access', operation: 'login'`. It TYPECHECKED, which is the
 * whole problem: `AccessDetails`'s union offered `login | logout |
 * session_revoked | permission_changed`, none of which describes a download,
 * so the author had four wrong answers and no right one and took the first.
 *
 * That lands on the Epic C.4 path — audit events stream HMAC-signed to a
 * SIEM, and `action` plus `detailsJson.operation` are what a consumer filters
 * on. A rule counting authentication events was counting file downloads.
 *
 * ## Why a guard, and why THIS guard
 *
 * No type can catch it: a union is the only machine-readable constraint on
 * the field and the wrong value satisfied it. `audit-details-category-is-
 * required` checks that a `category` is PRESENT, never that the operation
 * describes the action — and it could not in general.
 *
 * So this is deliberately narrow: it pins the ONE value whose misuse is both
 * severe (it corrupts authentication counts) and attractive (it is the first
 * member of the union, so a wrong-but-compiling choice lands on it). It does
 * not try to validate every operation against every action, which would be a
 * taxonomy nobody could maintain.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/**
 * Files allowed to emit it — authentication, and nothing else.
 *
 * An entry here is a claim that the file's `login` really is a sign-in.
 */
const AUTHENTICATION_FILES: readonly string[] = [
    'src/app-layer/usecases/mfa-challenge.ts',
];

const LOGIN_OPERATION = /\boperation:\s*['"`]login['"`]/;

function sourceFiles(): string[] {
    // `floor` is the shared helper's own minimum — the point of the module,
    // per its docblock — so an extraction that stopped matching fails here
    // rather than passing over nothing.
    return collectSourceFiles({
        roots: ['src'],
        extensions: ['.ts', '.tsx'],
        floor: 1000,
    });
}

describe("audit `operation: 'login'` is authentication-only (#3285)", () => {
    const files = sourceFiles();

    it('ranges over a real population', () => {
        // A floor, because an extraction that stopped matching would make
        // every assertion below pass over nothing.
        console.log(
            `[audit-login] scanned ${files.length} source file(s); ` +
                `${AUTHENTICATION_FILES.length} allowed to emit it`,
        );
        expect(files.length).toBeGreaterThan(1000);
    });

    it('no file outside the authentication set emits it', () => {
        const offenders: string[] = [];
        for (const abs of files) {
            const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
            if (AUTHENTICATION_FILES.includes(rel)) continue;
            // Comments stripped, STRINGS KEPT (`strings: false`). The value
            // being matched IS a string literal, so `strings: true` blanks it
            // and the scan finds nothing — a guard that passes because it
            // cannot see. My first draft had it the wrong way round and the
            // two controls below are what caught it.
            //
            // Comments must still go: `types.ts` and this file both explain
            // the old value by name and have to stay able to.
            const code = blankNonCode(readFileSync(abs, 'utf8'), { strings: false });
            if (LOGIN_OPERATION.test(code)) offenders.push(rel);
        }
        if (offenders.length > 0) {
            throw new Error(
                `These files audit something as a LOGIN:\n` +
                    offenders.map((f) => `  ${f}`).join('\n') +
                    `\n\nAn audit stream consumer counts authentication events on ` +
                    `\`operation: 'login'\`. If the event is not a sign-in, pick the ` +
                    `value that describes it — \`AccessDetails\` carries ` +
                    `\`file_downloaded\`, \`session_revoked\` and ` +
                    `\`permission_changed\`, and adding a member is cheaper than a ` +
                    `wrong record. #3285 is what this costs: an evidence download ` +
                    `audited as a login, typechecking all the way.`,
            );
        }
        expect(offenders).toEqual([]);
    });

    it('CONTROL: the detector finds it in the files that DO emit it', () => {
        // Without this, "no offenders" is satisfied by a regex that matches
        // nothing — which is how a guard against a one-line mistake becomes
        // decoration.
        const emitting = AUTHENTICATION_FILES.filter((rel) => {
            const code = blankNonCode(
                readFileSync(path.join(REPO_ROOT, rel), 'utf8'),
                { strings: false },
            );
            return LOGIN_OPERATION.test(code);
        });
        expect(emitting).toEqual([...AUTHENTICATION_FILES]);
    });

    it('CONTROL: the detector matches a crafted offender', () => {
        const crafted = `
            await logEvent(db, ctx, {
                action: 'THING_HAPPENED',
                detailsJson: { category: 'access', operation: 'login' },
            });
        `;
        expect(LOGIN_OPERATION.test(blankNonCode(crafted, { strings: false }))).toBe(true);
    });

    it('CONTROL: it does NOT match the value that replaced it', () => {
        const fixed = `detailsJson: { category: 'access', operation: 'file_downloaded' }`;
        expect(LOGIN_OPERATION.test(blankNonCode(fixed, { strings: false }))).toBe(false);
    });
});
