/**
 * `.trivyignore` exemptions must stay true, and must not outlive their subject.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * `.trivyignore` is an allowlist keyed by CVE id, and it is the one structural
 * escape hatch from the container CVE gate. Its own header states a contract —
 * every entry carries the id, the affected package path, why it is safe today,
 * and the trigger that retires it — and until now **nothing enforced any of
 * it**: `grep -rl trivyignore tests/` returned zero files.
 *
 * The npm-audit side has had a real gate for exactly this since #468's era
 * (`scripts/audit-exemptions.mjs`, whose rule is "exempt ONLY by GHSA id … so a
 * NEW advisory on the same package still blocks the merge"). Trivy had nothing.
 *
 * The consequence, found 2026-08-20: all eight entries exempted CVEs whose
 * stated affected path was `usr/local/lib/node_modules/npm/node_modules/...`,
 * while `Dockerfile:163` deletes that directory outright. The packages were
 * absent from the scanned image, so the exemptions matched nothing — and every
 * entry's retirement trigger ("the next base-image bump that ships an npm CLI
 * bundling …") had become unreachable, because the npm CLI is no longer in the
 * image at any version. The Dockerfile comment had even said so:
 * "Deleting the CLI removes the finding at the source rather than suppressing
 * it in .trivyignore." Nobody went back and deleted them.
 *
 * That is the specific failure this guard blocks: an exemption whose stated
 * path the image no longer contains. A dead entry is harmless the day it dies
 * and dangerous later, because `.trivyignore` suppresses a CVE id across the
 * WHOLE image — it has no notion of the path the comment names. `picomatch`
 * is the live example: CVE-2026-33671 was exempted on the argument that the
 * only vulnerable copy lived inside the npm CLI, while our own tree is pinned
 * safe by the `overrides` block in package.json. Drop that override, or take a
 * transitive dep that vendors its own copy, and the same id now describes a
 * package we really do ship — and Trivy stays silent, under a comment that
 * still reads as a considered justification for a situation that ended.
 *
 * The file is currently empty of entries. That is precisely when a guard rots
 * into a tautology, so the parser and every rule below are also exercised
 * against synthetic fixtures that MUST fail — see "the guard itself has teeth".
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const TRIVYIGNORE = path.join(REPO_ROOT, '.trivyignore');
const DOCKERFILE = path.join(REPO_ROOT, 'Dockerfile');

interface Entry {
    id: string;
    /** The contiguous comment block immediately above the id line. */
    comment: string;
    line: number;
}

/** A bare `CVE-…` / `GHSA-…` line is an entry; the block above it is its rationale. */
function parseEntries(src: string): Entry[] {
    const lines = src.split('\n');
    const out: Entry[] = [];
    for (let i = 0; i < lines.length; i++) {
        const id = lines[i].trim();
        if (!/^(CVE-\d{4}-\d+|GHSA-[\w-]+)$/.test(id)) continue;
        const block: string[] = [];
        for (let j = i - 1; j >= 0 && lines[j].trim().startsWith('#'); j--) {
            block.unshift(lines[j]);
        }
        out.push({ id, comment: block.join('\n'), line: i + 1 });
    }
    return out;
}

/** Absolute paths the Dockerfile removes, so they cannot exist in the scanned image. */
function deletedPaths(dockerfile: string): string[] {
    const out: string[] = [];
    // `RUN rm -rf /a \` + continuation lines of further paths.
    const re = /rm\s+-rf\s+([^\n]*(?:\\\n[^\n]*)*)/g;
    for (const m of dockerfile.matchAll(re)) {
        for (const tok of m[1].split(/[\s\\]+/)) {
            const t = tok.trim();
            if (t.startsWith('/')) out.push(t.replace(/\/+$/, ''));
        }
    }
    return out;
}

/** `usr/local/lib/...` and `/usr/local/lib/...` must compare equal. */
function normalise(p: string): string {
    return '/' + p.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function statedPath(comment: string): string | null {
    const m = comment.match(/Affected path:\s*([^\s(]+)/);
    return m ? m[1] : null;
}

const REQUIRED_FIELDS = ['Affected path:', 'Why exempt:', 'Upgrade plan:'] as const;

/** Returns a human-readable violation, or null when the entry is well-formed. */
function violationFor(entry: Entry, deleted: string[]): string | null {
    for (const field of REQUIRED_FIELDS) {
        if (!entry.comment.includes(field)) {
            return `${entry.id} (.trivyignore:${entry.line}) is missing a "${field}" field. `
                + `The file header requires the id, the affected package path, why it is safe `
                + `today, and the trigger that retires it.`;
        }
    }

    const stated = statedPath(entry.comment);
    if (!stated) {
        return `${entry.id} (.trivyignore:${entry.line}) has an "Affected path:" field with no path after it.`;
    }

    const norm = normalise(stated);
    for (const gone of deleted) {
        if (norm === gone || norm.startsWith(gone + '/')) {
            return `${entry.id} (.trivyignore:${entry.line}) exempts a CVE at "${stated}", but the `
                + `Dockerfile deletes "${gone}" — so that path is not in the image Trivy scans and `
                + `this exemption suppresses nothing. Delete the entry. (This is exactly how all `
                + `eight original entries went stale after the npm CLI was removed.)`;
        }
    }
    return null;
}

describe('.trivyignore — the exemption contract is enforced', () => {
    const src = fs.readFileSync(TRIVYIGNORE, 'utf8');
    const dockerfile = fs.readFileSync(DOCKERFILE, 'utf8');
    const deleted = deletedPaths(dockerfile);

    it('the Dockerfile-deletion parser finds the npm CLI removal', () => {
        // If this ever stops matching, every path check below silently passes
        // and the guard becomes decorative.
        expect(deleted).toContain('/usr/local/lib/node_modules/npm');
    });

    it('every entry is well-formed and still refers to a path the image contains', () => {
        const violations = parseEntries(src)
            .map((e) => violationFor(e, deleted))
            .filter((v): v is string => v !== null);

        if (violations.length > 0) {
            throw new Error(`.trivyignore has stale or malformed exemptions:\n\n${violations.join('\n\n')}`);
        }
    });

    it('the header still states the contract this guard enforces', () => {
        // The rules live in the file for the human adding an entry; this test
        // only enforces them. If the header goes, the error messages above stop
        // making sense to whoever hits them.
        for (const field of REQUIRED_FIELDS) {
            expect(src).toContain(field.replace(':', ''));
        }
    });
});

describe('the guard itself has teeth — synthetic fixtures that MUST be rejected', () => {
    // `.trivyignore` currently holds zero entries, so the suite above passes
    // vacuously. These fixtures are what stop this file from being a tautology:
    // they run the real parser and the real rules over hand-built input.
    const deleted = ['/usr/local/lib/node_modules/npm'];

    function only(src: string): string | null {
        const entries = parseEntries(src);
        expect(entries).toHaveLength(1);
        return violationFor(entries[0], deleted);
    }

    it('rejects the exact defect this guard was written for — a deleted path', () => {
        // A verbatim reconstruction of one of the eight original entries.
        const v = only(`
# CVE-2026-59873 — node-tar DoS via crafted gzip bomb
#   Affected path:  usr/local/lib/node_modules/npm/node_modules/tar (v7.5.16)
#   Why exempt:     bundled inside the npm CLI; runtime never execs npm
#   Upgrade plan:   base-image bump shipping tar >= 7.5.19
CVE-2026-59873
`);
        expect(v).toContain('the Dockerfile deletes');
    });

    it.each(REQUIRED_FIELDS)('rejects an entry missing "%s"', (missing) => {
        const block = REQUIRED_FIELDS
            .filter((f) => f !== missing)
            .map((f) => `#   ${f} something`)
            .join('\n');
        const v = only(`# CVE-2026-00001 — synthetic\n${block}\nCVE-2026-00001\n`);
        expect(v).toContain(missing);
    });

    it('accepts a well-formed entry whose path the image DOES contain', () => {
        // The positive control. Without it, a rule that rejected everything
        // would look identical to a rule that works.
        const v = only(`
# CVE-2026-00002 — synthetic, in the app tree
#   Affected path:  app/node_modules/some-lib
#   Why exempt:     not reachable from any request path
#   Upgrade plan:   cleared by the next some-lib major
CVE-2026-00002
`);
        expect(v).toBeNull();
    });

    it('normalises leading slashes — `usr/...` and `/usr/...` are the same path', () => {
        // Trivy reports paths without a leading slash; the Dockerfile writes
        // them with one. A guard that missed this would pass the stale entries.
        const v = only(`
# CVE-2026-00003 — synthetic
#   Affected path:  /usr/local/lib/node_modules/npm/node_modules/tar
#   Why exempt:     n/a
#   Upgrade plan:   n/a
CVE-2026-00003
`);
        expect(v).toContain('the Dockerfile deletes');
    });
});
