/**
 * Guard: no bare `notFound()` throws a message whose code already exists (#1712).
 *
 * ## What #1712 actually is, measured
 *
 * The issue says 81 uncoded sites. That number is right, and getting to it
 * needs two discriminations the obvious grep does not make:
 *
 *   • **Next.js has its own `notFound()`**, from `next/navigation`, and it
 *     renders the 404 PAGE. It takes no code and never will — coding it is a
 *     category error, not a fix. 21 calls in 18 files, excluded here by the
 *     IMPORT rather than by the filename, because a page file may use either.
 *   • **A docblock `@throws notFound(...)` is a scar, not a wound.** Comments
 *     are blanked before matching (#1774). Unblanked, the count was 102.
 *
 * Of the 81 real sites, 12 needed no new code at all: a code with a Bulgarian
 * entry already existed for the same resource, and the site simply had not
 * been converted. 11 were converted with this guard; the 67 that remain need
 * a new code AND its `messages/{en,bg}.json` entry together, which is the
 * rule #1918 records.
 *
 * ## Why a guard and not just the conversions
 *
 * Eleven one-line conversions revert silently. Nothing about
 * `throw notFound('Season not found')` looks wrong, and the thing that makes
 * it wrong — that `SEASON_NOT_FOUND` exists two directories away with a
 * Bulgarian sentence attached — is not visible at the call site. That is the
 * condition this holds.
 *
 * It is deliberately NOT a ban on bare `notFound()`. 67 sites legitimately
 * have no code yet, and a guard that failed on all of them would be switched
 * off the same week. It fails only where the code already exists, which is
 * the case with no argument for it.
 */
import { readCatalogue } from '../helpers/catalogue';
import { readFileSync } from 'node:fs';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

const bg = readCatalogue('bg') as { errors?: Record<string, unknown> };
const ENTRIED = new Set(Object.keys(bg.errors ?? {}));

/**
 * `'Season not found'` → `SEASON_NOT_FOUND`.
 *
 * Interpolations are dropped first, so `` `Task ${id} not found` `` still
 * yields `TASK_NOT_FOUND` rather than a name containing the expression.
 */
function candidateCode(message: string): string | null {
    const noun = message
        .replace(/\$\{[^}]*\}/g, '')
        .replace(/\bnot found\b.*/i, '')
        .replace(/^(the|a|an|this|that)\s+/i, '')
        .replace(/[^A-Za-z0-9 ]/g, '')
        .trim()
        .replace(/\s+/g, '_')
        .toUpperCase();
    return noun ? `${noun}_NOT_FOUND` : null;
}

/**
 * Sites that match a code which exists, and must NOT use it.
 *
 * One entry, and the reason is the whole point of having a list rather than
 * an exception: `org-tenants.ts` says "Tenant not found in this
 * organization". `TENANT_NOT_FOUND` now reads «Това стопанство не е
 * намерено. Възможно е да е премахнато или достъпът Ви до него да е
 * прекратен.» — removed, or your access ended. Neither is what happened. The
 * farm exists and the caller may well have access to it; it is not in THIS
 * organisation. Reusing the entry would make the sentence confidently wrong,
 * which is worse than leaving it in English until it gets a code of its own.
 */
const ALLOWED: ReadonlyArray<[file: string, message: string]> = [
    ['app-layer/usecases/org-tenants.ts', 'Tenant not found in this organization'],
];

interface Site {
    file: string;
    message: string;
    code: string;
}

function scan(): { sites: Site[]; bare: number; nextjs: number; uncodeable: number; files: number } {
    const files = collectSourceFiles({ roots: ['src'], extensions: ['.ts', '.tsx'], floor: 500 });
    const sites: Site[] = [];
    let bare = 0;
    let nextjs = 0;
    let uncodeable = 0;
    for (const abs of files) {
        const raw = readFileSync(abs, 'utf8');
        if (!raw.includes('notFound')) continue;
        const rel = abs.slice(REPO_ROOT.length + 1).replace(/^src\//, '');
        // The import decides WHICH notFound is in scope. Checked on the raw
        // text: an import is not a comment, and blanking cannot hide it.
        if (/import\s*\{[^}]*\bnotFound\b[^}]*\}\s*from\s*['"]next\/navigation['"]/.test(raw)) {
            nextjs += [...blankNonCode(raw).matchAll(/(?<!coded)\bnotFound\s*\(/g)].length;
            continue;
        }
        const code = blankNonCode(raw);
        for (const m of code.matchAll(/(?<!coded)\bnotFound\s*\(\s*([`'"])([^`'"]*)\1/g)) {
            const line = code.slice(code.lastIndexOf('\n', m.index) + 1, code.indexOf('\n', m.index));
            if (/^\s*(import|export)\b/.test(line)) continue;
            bare++;
            const message = m[2];
            const candidate = candidateCode(message);
            if (candidate && ENTRIED.has(candidate)) {
                if (ALLOWED.some(([f, msg]) => f === rel && msg === message)) continue;
                sites.push({ file: rel, message, code: candidate });
            } else {
                uncodeable++;
            }
        }
    }
    return { sites, bare, nextjs, uncodeable, files: files.length };
}

describe('a bare notFound() has no coded twin (#1712)', () => {
    const { sites, bare, nextjs, uncodeable, files } = scan();

    it('ranges over the real population — the denominators', () => {
        // Three numbers, because one of them alone misleads. The bare count
        // is the issue's 81; the next/navigation count is what a naive grep
        // adds to it; the uncodeable count is the work that genuinely
        // remains and needs a code AND a Bulgarian entry per site.
        console.log(
            `[notfound-twin] ${files} src files, ${bare} bare notFound() with a literal message, ` +
                `${nextjs} next/navigation call(s) excluded, ${uncodeable} with no existing code, ` +
                `${sites.length} finding(s)`,
        );
        // A floor well under the live count separates "nothing is wrong" from
        // "nothing was examined" — the failure the tests #1784 deleted had.
        expect(bare).toBeGreaterThan(40);
        expect(nextjs).toBeGreaterThan(5);
    });

    it('the detector finds a real one — the control it needs', () => {
        // Without this, a candidateCode() that returned null for everything
        // would make the assertion below pass for ever, which is the defect
        // this family keeps producing.
        expect(candidateCode('Season not found')).toBe('SEASON_NOT_FOUND');
        expect(candidateCode('Task ${id} not found')).toBe('TASK_NOT_FOUND');
        expect(candidateCode('Membership not found or not active.')).toBe('MEMBERSHIP_NOT_FOUND');
        // And those codes really are entried, or the rule has no teeth.
        expect(ENTRIED.has('SEASON_NOT_FOUND')).toBe(true);
        expect(ENTRIED.has('TASK_NOT_FOUND')).toBe(true);

        // The other direction: a resource with no code must NOT be reported,
        // or the guard becomes the ban on bare notFound() it must not be.
        expect(ENTRIED.has(candidateCode('Delivery not found') as string)).toBe(false);
    });

    it('every allowlist entry still describes a real site', () => {
        // An allowlist outlives what it excuses. If `org-tenants.ts` is
        // converted or its wording changes, this entry becomes a silent
        // licence for whatever later matches that file and message.
        for (const [file, message] of ALLOWED) {
            const raw = readFileSync(`${REPO_ROOT}/src/${file}`, 'utf8');
            expect(`${file}: ${message}`).toBe(
                blankNonCode(raw).includes(message) ? `${file}: ${message}` : `${file}: GONE`,
            );
        }
    });

    it('no site throws a message whose code already exists', () => {
        expect(
            sites.map((s) => `  ${s.file}: notFound('${s.message}') → ${s.code} exists`).join('\n'),
        ).toBe('');
    });
});
