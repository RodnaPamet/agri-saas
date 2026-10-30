/**
 * CI Guardrail Tests — Issue → Task Migration
 *
 * These tests scan the codebase to ensure that legacy Issue model references
 * do not creep back in. They enforce "Tasks are the only work item."
 *
 * #1479 finished the migration these guardrails were written during. The
 * `/issues/**` route surface, `usecases/issue.ts`, `policies/issue.policies.ts`
 * and both deprecated repositories are gone, so `ALLOWED_LEGACY_FILES` shrank
 * from five entries to one.
 *
 * The route assertion changed SHAPE at the same time, and that is the
 * load-bearing part. It read:
 *
 *     if (!fs.existsSync(issueRoutesDir)) return; // routes already removed
 *
 * — so the moment the retirement it was anticipating actually happened, the
 * test would pass by not running, and nothing would stop the surface coming
 * back. It asserts the directory's ABSENCE now. An early return that
 * anticipates a future deletion becomes a silent pass on the day of it.
 */
import fs from 'fs';
import path from 'path';
import { readPrismaSchema } from '../helpers/prisma-schema';

import { blankNonCode } from '../helpers/blank-non-code';

const SRC_DIR = path.resolve(__dirname, '../../src');

function grepFiles(pattern: RegExp, dir: string, extensions: string[]): { file: string; line: number; content: string }[] {
    const results: { file: string; line: number; content: string }[] = [];
    const walk = (d: string) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) {
                if (['node_modules', '.next', '.git', 'dist'].includes(entry.name)) continue;
                walk(full);
            } else if (extensions.some(ext => entry.name.endsWith(ext))) {
                // Comments blanked (#1774). Scanned per LINE below, which is
                // safe because `blankNonCode` preserves positions and
                // newlines — a blanked character becomes a space, so the line
                // numbers it reports still point where they did.
                const content = blankNonCode(fs.readFileSync(full, 'utf-8'));
                content.split('\n').forEach((line, i) => {
                    if (pattern.test(line)) {
                        results.push({ file: path.relative(SRC_DIR, full), line: i + 1, content: line.trim() });
                    }
                });
            }
        }
    };
    walk(dir);
    return results;
}

// Allowed files that contain legacy Issue references as shims/compatibility wrappers
// Annotated explicitly: the list is EMPTY, and an empty array literal infers
// `any[]` under noImplicitAny — `tsc` reported TS7034/TS7005 three times once
// the last entry went. The single entry used to supply the type for free.
const ALLOWED_LEGACY_FILES: readonly string[] = [
    // The other four entries (`repositories/IssueRepository.ts`,
    // `repositories/EvidenceBundleRepository.ts`, `usecases/issue.ts`,
    // `policies/issue.policies.ts`) were deleted by #1479. This list is
    // SHRINK-ONLY: an addition means a new file carrying legacy Issue
    // references, which is the thing these guardrails exist to prevent.
    // `events/audit.ts` removed 2026-10-30 (#2414). It was the last entry and
    // it was DEAD: measured against this file's three legacy patterns —
    // /\bdb\.issue\b(?!s)/, /\bdb\.(issueLink|issueComment|issueWatcher|
    // issueEvidenceBundle)\b/ and /prisma\.issue(Link|Comment)?\.create/ — it
    // matches NONE on comment-blanked source. The entry read as an accepted
    // legacy reference over a file that has none.
];

/**
 * The matcher, parameterised over the list — #2377's reusable principle.
 *
 * The list is EMPTY now, so a control that iterates it proves nothing: "every
 * entry matches itself" is vacuously true over zero entries. Taking the list as
 * an argument lets the control feed a suffix the repo no longer contains, which
 * is the only way to keep the `endsWith` logic proven while the live list is
 * empty.
 */
export function isAllowedIn(list: readonly string[], file: string): boolean {
    return list.some(allowed => file.replace(/\\/g, '/').endsWith(allowed));
}

// NO `isAllowed(file)` ADAPTER — #2377 names this trap about its own author:
//
//   "making the predicate pure and testing the pure version is not enough. My
//    first attempt kept one-line adapters over the pure predicates, and
//    selector-teeth reported the same selector dead a SECOND time — the wrapper
//    was ungraded ... The adapters were removed rather than wrapped in more
//    tests."
//
// I wrote exactly that adapter and selector-teeth reported it on the next run:
// `isAllowed() -> return false SURVIVED`. With the list empty the real
// implementation already returns false for every input, so the gut is a no-op
// and the wrapper cannot be graded at all. Call sites use `isAllowedIn` with
// the list passed explicitly, which IS graded — gutting it fails the synthetic
// control below.

describe('Issue → Task Migration Guardrails', () => {
    test('[issue-guards] grepFiles can actually find a pattern — the control', () => {
        // Reported dead by `scripts/selector-teeth.mjs`: gutted to a constant
        // it SURVIVED, because every assertion on it is `hits.length === 0`
        // and an empty result satisfies all of them (#2407).
        //
        // The control asks for something CERTAINLY present rather than
        // anything about Issue references, so it stays true however the
        // migration progresses.
        const exports = grepFiles(/\bexport\b/, SRC_DIR, ['.ts', '.tsx']);
        console.log(`[issue-guards] grepFiles found ${exports.length} line(s) matching /\\bexport\\b/`);
        expect(exports.length).toBeGreaterThan(100);
        // The shape the callers read: a relative file, a 1-based line, and the
        // trimmed content. A result that lost its `line` would still satisfy a
        // length assertion while making every report unusable.
        expect(exports[0].file).not.toMatch(/^\//);
        expect(exports[0].line).toBeGreaterThan(0);
        expect(exports[0].content.length).toBeGreaterThan(0);
        // The extension filter is part of the selector: widened, it would feed
        // .json and .css to a matcher that reads them as TypeScript.
        expect(exports.every((h) => h.file.endsWith('.ts') || h.file.endsWith('.tsx'))).toBe(true);
    });

    test('[issue-guards] isAllowedIn excludes the allowlist and NOTHING else', () => {
        // The more dangerous of the two. `isAllowedIn` is only ever reached via
        // `.filter(h => !isAllowedIn(ALLOWED_LEGACY_FILES, h.file))`, and `hits` is empty today — so
        // the filter never calls it and any constant survives.
        //
        // A TRUTHY constant is the one that matters: `isAllowedIn` returning
        // true for everything would filter out every violation, and all three
        // tests below would report zero hits no matter what the codebase
        // contained. The allowlist would have become a universal exemption
        // with nothing saying so.
        // The live list is EMPTY, so iterating it proves nothing. Feed the
        // matcher a SYNTHETIC entry instead — the suffix logic must stay
        // proven even though the repo no longer contains a legacy file.
        const SYNTH = ['events/legacy-example.ts'];
        expect(isAllowedIn(SYNTH, 'events/legacy-example.ts')).toBe(true);
        // ...with a leading path, since callers pass SRC_DIR-relative paths
        expect(isAllowedIn(SYNTH, 'some/nested/events/legacy-example.ts')).toBe(true);
        // ...and with Windows separators, which the implementation normalises
        expect(isAllowedIn(SYNTH, 'some\\nested\\events\\legacy-example.ts')).toBe(true);
        // ...and a near miss must NOT match
        expect(isAllowedIn(SYNTH, 'events/legacy-examples.ts')).toBe(false);
        // The live list being empty means nothing is exempt, which the negative
        // cases below still prove against a truthy constant.
        expect(ALLOWED_LEGACY_FILES).toEqual([]);
        for (const notAllowed of [
            'lib/prisma.ts',
            'app-layer/usecases/task.ts',
            'events/audit-log.ts',        // a near miss on events/audit.ts
            'other/events/audits.ts',     // plural, must not match
            '',
        ]) {
            expect({ notAllowed, isAllowed: isAllowedIn(ALLOWED_LEGACY_FILES, notAllowed) })
                .toEqual({ notAllowed, isAllowed: false });
        }
    });

    test('Prisma schema must NOT contain Issue model', () => {
        const schema = readPrismaSchema();
        const issueModels = schema.match(/^model\s+(Issue|IssueLink|IssueComment|IssueWatcher|IssueEvidenceBundle)\s*\{/gm);
        expect(issueModels).toBeNull();
    });

    test('No code references db.issue (raw Prisma Issue model access)', () => {
        const hits = grepFiles(/\bdb\.issue\b(?!s)/, SRC_DIR, ['.ts', '.tsx'])
            .filter(h => !isAllowedIn(ALLOWED_LEGACY_FILES, h.file));
        if (hits.length > 0) {
            const summary = hits.map(h => `  ${h.file}:${h.line}  ${h.content}`).join('\n');
            fail(`Found ${hits.length} references to db.issue (should use db.task):\n${summary}`);
        }
    });

    test('No code references db.issueLink/db.issueComment/db.issueWatcher', () => {
        const hits = grepFiles(/\bdb\.(issueLink|issueComment|issueWatcher|issueEvidenceBundle)\b/, SRC_DIR, ['.ts', '.tsx'])
            .filter(h => !isAllowedIn(ALLOWED_LEGACY_FILES, h.file));
        if (hits.length > 0) {
            const summary = hits.map(h => `  ${h.file}:${h.line}  ${h.content}`).join('\n');
            fail(`Found references to legacy Issue sub-models:\n${summary}`);
        }
    });

    test('No new Prisma model with "Issue" in the name', () => {
        const schema = readPrismaSchema();
        const models = schema.match(/^model\s+\w*Issue\w*\s*\{/gm);
        expect(models).toBeNull();
    });

    test('the /issues API surface is GONE and does not come back', () => {
        // Was: `if (!existsSync(dir)) return;` — which turned into a silent
        // pass the day #1479 removed the directory, leaving nothing to stop a
        // reinstatement. The absence is the assertion now.
        //
        // 15 routes wrote `Task` rows through a usecase layer that never
        // invalidated the task cache and stamped its audit rows
        // `entityType: 'Issue'` — a model the schema does not have. Three of
        // them served a stubbed `EvidenceBundleRepository` whose list methods
        // returned `[]`, so a client was told an issue had no evidence bundles
        // rather than that bundles do not exist.
        const issueRoutesDir = path.join(SRC_DIR, 'app/api/t/[tenantSlug]/issues');
        expect(fs.existsSync(issueRoutesDir)).toBe(false);
    });

    test('no module re-exports the retired Issue usecase, policy or repositories', () => {
        // The deletion's own ratchet. Each of these was a live file until
        // #1479, and each is the kind a future reader could recreate as a
        // "compatibility shim" without knowing the surface was retired
        // deliberately.
        for (const gone of [
            'app-layer/usecases/issue.ts',
            'app-layer/policies/issue.policies.ts',
            'app-layer/repositories/IssueRepository.ts',
            'app-layer/repositories/EvidenceBundleRepository.ts',
        ]) {
            expect(fs.existsSync(path.join(SRC_DIR, gone))).toBe(false);
        }
    });

    test('Tasks are the only work item: no model creates Issue-based entities', () => {
        const hits = grepFiles(/prisma\.issue\.create|prisma\.issueLink\.create|prisma\.issueComment\.create/, SRC_DIR, ['.ts', '.tsx']);
        expect(hits.length).toBe(0);
    });
});
