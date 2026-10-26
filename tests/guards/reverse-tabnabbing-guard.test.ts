/**
 * Reverse-tabnabbing guard.
 *
 * Every `target="_blank"` link must pair with `rel="noopener
 * noreferrer"`. When it doesn't, a malicious target page can reach
 * back into the opener via `window.opener` (tabnabbing). The risk is
 * acute for user-supplied URLs (vendor websites, policy documents).
 *
 * The guard scans tenant-page source for `target="_blank"` and
 * asserts each occurrence sits within a tag that also contains
 * `rel="noopener"` (with or without `noreferrer`). This is a
 * ratchet-style check — the count may only go DOWN.
 *
 * Allowlist: empty-state.tsx / tooltip.tsx / filter-list.tsx under
 * `src/components/ui/` host hard-coded links (docs / Dub-ported help
 * links). Those are out-of-scope for this guard because the URLs
 * aren't user-controlled. Tenant pages are in-scope because they
 * surface vendor/evidence URLs that users type in.
 */

import * as fs from 'fs';
import * as path from 'path';

const APP_PAGES_ROOT = path.resolve(__dirname, '../../src/app/t');

function walk(dir: string, out: string[]): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
}

const SOURCES = walk(APP_PAGES_ROOT, []).map((p) => ({
    file: path.relative(APP_PAGES_ROOT, p),
    src: fs.readFileSync(p, 'utf-8'),
}));

interface Source {
    file: string;
    src: string;
}

/**
 * Scan JSX sources for opening tags that contain target="_blank" but NOT
 * rel="noopener" anywhere in the same tag.
 *
 * Takes its sources as a PARAMETER. It closed over the module-level `SOURCES`
 * and `scripts/selector-teeth` reported it dead: gutted to `return []` it
 * survived, because the only assertion on it is
 * `expect(offenders).toEqual([])` — a NEGATIVE assertion that an
 * always-empty function satisfies perfectly. A detector whose output is only
 * ever compared against "nothing" cannot be shown to detect anything.
 *
 * The parameter is what makes the control below possible: the repo contains no
 * offender (that is the point of the guard), so the only way to prove the
 * scanner works is to hand it one.
 */
function findUnsafeTabnabs(sources: readonly Source[]): string[] {
    const offenders: string[] = [];
    // Match any opening tag that contains target="_blank". Uses
    // `[\s\S]` rather than the `s` (dot-all) flag so the file compiles
    // under the ES2017 regex target configured in tsconfig.
    const tagRe = /<[a-zA-Z][\s\S]*?target=["']_blank["'][\s\S]*?>/g;
    for (const { file, src } of sources) {
        const matches = src.match(tagRe) ?? [];
        for (const match of matches) {
            if (!/rel=["'][^"']*noopener/i.test(match)) {
                offenders.push(`${file}: ${match.slice(0, 120)}…`);
            }
        }
    }
    return offenders;
}

describe('Reverse-tabnabbing guard', () => {
    it('[tabnabbing] ranges over a real set of tenant pages — the denominator', () => {
        // #2377. The assertion below is a NEGATIVE one: it demands that no
        // `target="_blank"` lacks `rel="noopener"`. An empty `SOURCES` passes
        // it by construction, reporting compliance having read nothing.
        //
        // The root is not the exposure — `readdirSync` throws ENOENT if
        // `src/app/t` disappears. What this bounds is the FILTER: every tenant
        // page renamed away from `.tsx`, or moved out of `src/app/t`, leaves a
        // directory that still resolves and a population that is empty.
        console.log(`[tabnabbing] ${SOURCES.length} tenant page file(s) scanned`);
        expect(SOURCES.length).toBeGreaterThan(20);
    });

    it('the scanner can actually find an offender — the control', () => {
        // Synthetic, because the repo deliberately contains none. Without
        // this the assertion below is satisfied by a scanner that returns []
        // unconditionally, which is exactly what the tool found.
        const unsafe = findUnsafeTabnabs([
            { file: 'synthetic.tsx', src: '<a href="https://x" target="_blank">x</a>' },
        ]);
        expect(unsafe).toHaveLength(1);
        expect(unsafe[0]).toContain('synthetic.tsx');

        // And the other direction, so a scanner that flagged EVERYTHING would
        // not pass either — that would make the real assertion unclearable.
        expect(
            findUnsafeTabnabs([
                { file: 'safe.tsx', src: '<a href="https://x" target="_blank" rel="noopener noreferrer">x</a>' },
            ]),
        ).toEqual([]);
        // `rel` before `target` in the same tag must also count as safe.
        expect(
            findUnsafeTabnabs([
                { file: 'safe2.tsx', src: '<a rel="noopener" href="https://x" target="_blank">x</a>' },
            ]),
        ).toEqual([]);
    });

    it('every target="_blank" in tenant pages pairs with rel="noopener"', () => {
        const offenders = findUnsafeTabnabs(SOURCES);
        if (offenders.length > 0) {
            throw new Error(
                `Found ${offenders.length} target="_blank" link(s) in tenant pages without rel="noopener":\n\n` +
                    offenders.join('\n') +
                    '\n\nFix: add rel="noopener noreferrer" or use the shared EXTERNAL_LINK_ATTRS from @/lib/security/safe-url.',
            );
        }
        expect(offenders).toEqual([]);
    });
});
