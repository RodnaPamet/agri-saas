/**
 * Every file-shaped exemption entry names a file that exists — #2377.
 *
 * ## The class, and why a denominator does not catch it
 *
 * #2377 asks for the mechanisable subset of "a control must be able to express
 * the failing input even when the repo cannot". Its §1 names two checks that
 * fail on different things:
 *
 *   - an EMPTY population means the guard looked at nothing;
 *   - a UNIFORM population means it looked at something and could not have
 *     reached a verdict either way.
 *
 * The second is the one that cost us: `restore-drill-targets` ranged over two
 * stacks and graded nothing, because both landed on the same side of the
 * partition. No count sees that.
 *
 * This guard is the both-branches check for the commonest partition shape in
 * this repo — **a scan plus an exemption list**. For that shape the check is
 * concrete: if the exemption list is non-empty and every entry really is in the
 * scanned population, then the exempt branch provably gets a member, so the
 * predicate that decides exemption is graded on every run. An entry naming a
 * file that no longer exists is the uniformity failure in its stable form — the
 * branch it was written for can never be taken again.
 *
 * It is NOT the general principle, and must not be read as closing #2377. The
 * inputs-changed audit window (§2) and the general case — a partition whose
 * sides are not an allowlist — are still open there.
 *
 * ## It found a nine-month-old dead exemption, from a commit already known to leave them
 *
 * `no-compact-filter-bar` exempted `tests/unit/practices-filter-defs.test.ts`,
 * deleted in `eba5cf890` (#547, the GRC teardown). That is the SAME commit that
 * deleted `ClauseRepository.ts`, one of two dead `REPO_ALLOWLIST` entries found
 * by hand in #2412. One teardown left stale exemptions in at least two guards
 * and nothing noticed, which is the argument for deriving this rather than
 * grepping when someone happens to look.
 *
 * ## The resolution rule is load-bearing, and three plausible rules disagree
 *
 * Measured on the same 159 entries, the count is a property of the RULE:
 *
 *   | rule                              | flagged | wrong                        |
 *   | --------------------------------- | ------- | ---------------------------- |
 *   | exact repo-root path              | 48      | 46 false — see below         |
 *   | basename anywhere in the repo      | 2       | blind to a MOVED file        |
 *   | suffix at a segment boundary      | 2       | none found                   |
 *
 * Most exemption lists store paths relative to the guard's own scan root
 * (`assets/[id]/MaintenanceTab.tsx`, under `src/app/t/[tenantSlug]/(app)/`), so
 * demanding a repo-root path calls 46 live entries dead. A bare basename match
 * fixes that and goes blind to exactly the case this repo just created: #2385
 * moved twelve guards out of `tests/unit`, so `tests/unit/x.test.ts` and
 * `tests/guards/x.test.ts` share a basename while the first names nothing.
 * Suffix matching keeps the relative forms and still fails the move, because
 * `tests/unit/x.test.ts` is not a trailing segment run of `tests/guards/x.test.ts`.
 */
import { execSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

import { join } from 'path';

import { blankNonCode } from '../helpers/blank-non-code';

const GUARD_GLOBS = [
    'tests/guards/*.test.ts',
    'tests/guardrails/*.test.ts',
    'tests/contracts/*.test.ts',
    'tests/regression/*.test.ts',
];

/**
 * Constants whose NAME declares them an exemption. Deliberately a name rule:
 * the alternative is inferring intent from how a set is used, and a guard that
 * has to be right about that would be wrong quietly.
 */
const EXEMPT_NAME = /(ALLOWLIST|ALLOWED|EXEMPT|WAIVER|VM_PROVIDED|PERMITTED|LEGACY|IGNORE|SKIP)/;

/**
 * An entry is in scope only if it carries a BASENAME before a source
 * extension. The basename is required: without it a bare `'.ts'` in an
 * extension list reads as a filename, which is how the first version of this
 * scan invented three findings in `uncoded-helper-called-with-a-code`.
 */
const FILEISH = /[A-Za-z0-9_.\-[\]()]+\.(ts|tsx|js|jsx|mjs|cjs|json|sh|yml|yaml|sql|prisma)$/;

/**
 * Entries that name something absent ON PURPOSE, each with the reason. An entry
 * here is a claim that the absence is the design — not debt to be tidied.
 *
 * This constant is NOT named like an exemption, so the scan below does not read
 * it, and that is deliberate: it keeps the escape hatch out of the population
 * it exempts from, rather than relying on it to exempt itself.
 */
const DELIBERATELY_ABSENT: Readonly<Record<string, string>> = {
    'pnpm-lock.yaml':
        "no-secrets' SKIP_PATHS lists package-lock.json, yarn.lock and pnpm-lock.yaml "
        + 'together. This repo uses npm, so only the first exists — the other two are '
        + 'DEFENSIVE breadth, so that switching package manager cannot start scanning a '
        + 'lockfile for secrets. Costs nothing and is not stale debt: a lockfile this '
        + 'repo does not have is exactly what the entry is for.',
};

interface Entry {
    guard: string;
    constant: string;
    value: string;
}

/**
 * Slice from `open` to its MATCHING bracket, counting depth and skipping
 * strings and comments.
 *
 * A regex cannot do this. The first version used
 * `/=\s*([[{][\s\S]*?^(?:\]|\}))/m`, which runs to the first `]` at column 0 —
 * so a const whose closing bracket is indented swallowed every `it` body after
 * it and reported their fixtures (`'synthetic.tsx'`) as exemption entries.
 */
export function balanced(src: string, open: number): string | null {
    const close = src[open] === '[' ? ']' : '}';
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '\\') {
            i++;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') {
            const q = c;
            for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++;
            continue;
        }
        if (c === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i);
            if (end < 0) break;
            i = end + 1;
            continue;
        }
        if (c === src[open]) depth++;
        else if (c === close) {
            depth--;
            if (depth === 0) return src.slice(open, i + 1);
        }
    }
    return null;
}

/**
 * Tracked files PLUS untracked-but-not-ignored ones.
 *
 * `git ls-files` alone lists only what is committed, so a guard added in the
 * current PR is absent from its own scan until it is staged — and so is any
 * exemption list it brings with it. This guard's self-inclusion test below is
 * what surfaced that: the file was failing to find itself.
 */
function guardFiles(): string[] {
    return execSync(`git ls-files --cached --others --exclude-standard ${GUARD_GLOBS.map((g) => `'${g}'`).join(' ')}`, {
        cwd: process.cwd(),
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
    })
        .trim()
        .split('\n')
        .filter(Boolean);
}

/** Every tracked path, plus every trailing segment run of each. */
function resolver(): { exact: Set<string>; suffix: Set<string>; base: Set<string> } {
    // Same reason as guardFiles(): a file ADDED in this PR must resolve, or
    // every allowlist entry naming it reads as stale debt.
    const tracked = execSync('git ls-files --cached --others --exclude-standard', {
        cwd: process.cwd(),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    })
        .trim()
        .split('\n')
        .filter(Boolean);
    const suffix = new Set<string>();
    const base = new Set<string>();
    for (const p of tracked) {
        const seg = p.split('/');
        base.add(seg[seg.length - 1]);
        for (let i = 1; i < seg.length; i++) suffix.add(seg.slice(i).join('/'));
    }
    return { exact: new Set(tracked), suffix, base };
}

const REPO_ROOT = process.cwd();
const R = resolver();

export function namesSomethingReal(entry: string): boolean {
    const clean = entry.replace(/^\.\//, '');
    // A bare basename stays a basename match — there is no directory in it to
    // be wrong about. Anything with a directory must match whole trailing
    // segments, which is what still fails on a file that MOVED.
    return clean.includes('/')
        ? R.exact.has(clean) || R.suffix.has(clean) || existsSync(clean)
        : R.base.has(clean);
}

export function exemptionEntries(files: string[]): Entry[] {
    const out: Entry[] = [];
    for (const guard of files) {
        // Comments BLANKED first, and `blankNonCode` blanks to spaces rather
        // than deleting, so every offset below still lines up.
        //
        // This is not hygiene, it is a correctness fix. The literal scan reads
        // the whole bracket body, comments included, so a commented-out entry
        //
        //     const FOO_ALLOWLIST = [
        //         // 'src/old.ts',   <- removed last year
        //         'src/new.ts',
        //     ];
        //
        // was read as a live entry and reported stale — a scar reported as a
        // wound, and this guard would have been its own first false positive.
        // Strings are KEPT (`strings` defaults to false): they are the subject.
        const src = blankNonCode(readFileSync(guard, 'utf8'));
        const re = /^const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]*)?=\s*(?=[[{])/gm;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
            const constant = m[1];
            if (!EXEMPT_NAME.test(constant)) continue;
            const body = balanced(src, m.index + m[0].length);
            if (body === null) continue;
            for (const lit of body.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)) {
                const value = lit[1] ?? lit[2];
                // A glob names no single file, so it cannot be resolved and is
                // out of scope rather than guessed at — #2377 puts computed
                // and globbed inputs with the sampling fallback, not here.
                if (!value || /[*?]/.test(value) || !FILEISH.test(value)) continue;
                out.push({ guard, constant, value });
            }
        }
    }
    return out;
}

const FILES = guardFiles();
const ENTRIES = exemptionEntries(FILES);

describe('file-shaped exemption entries name something real (#2377)', () => {
    it('[exemption-entries] ranges over a real population — the denominator', () => {
        const decls = new Set(ENTRIES.map((e) => `${e.guard}#${e.constant}`));
        console.log(
            `[exemption-entries] ${FILES.length} guard file(s) scanned; `
                + `${decls.size} exemption declaration(s) with file-shaped entries; `
                + `${ENTRIES.length} entr(ies); `
                + `${Object.keys(DELIBERATELY_ABSENT).length} declared deliberately absent`,
        );
        // Measured 32 declarations / 159 entries on e4a7bc636. Floors well
        // under that, because this guard's whole subject is a check that passes
        // over nothing — an extraction that broke would otherwise be the exact
        // defect it exists to catch, one level up.
        expect(FILES.length).toBeGreaterThanOrEqual(600);
        expect(decls.size).toBeGreaterThanOrEqual(20);
        expect(ENTRIES.length).toBeGreaterThanOrEqual(100);
    });

    it('[exemption-entries] the population includes BOTH test roots that hold exemptions', () => {
        // tests/guards and tests/guardrails are different directories, and the
        // one real finding lives in guardrails. A glob list that quietly lost a
        // root would keep a healthy-looking denominator from the other.
        const roots = new Set(ENTRIES.map((e) => e.guard.split('/').slice(0, 2).join('/')));
        expect([...roots].sort()).toContain('tests/guardrails');
        expect([...roots].sort()).toContain('tests/guards');
        // And this file is itself in the scanned set, so the scan cannot be
        // excluding the directory it lives in.
        expect(FILES).toContain('tests/guards/exemption-entries-name-something-real.test.ts');
    });

    it.each(ENTRIES.map((e) => [`${e.guard.replace('tests/', '')} ${e.constant} ${e.value}`, e] as const))(
        '%s',
        (_label, e) => {
            if (e.value in DELIBERATELY_ABSENT) return;
            expect({ entry: e.value, namesSomethingReal: namesSomethingReal(e.value) }).toEqual({
                entry: e.value,
                namesSomethingReal: true,
            });
        },
    );

    it('every deliberately-absent entry carries a reason, and is really absent', () => {
        // Without the second half, a file DELETED from the repo could be parked
        // here and this guard would stop noticing — real debt re-entering
        // through the door built for the one absence that is intended.
        for (const [value, why] of Object.entries(DELIBERATELY_ABSENT)) {
            expect({ value, explained: why.length > 120 }).toEqual({ value, explained: true });
            expect({ value, resolves: namesSomethingReal(value) }).toEqual({
                value,
                resolves: false,
            });
        }
    });

    it('every deliberately-absent entry is actually still listed by some guard', () => {
        // The other direction: an entry here for something no exemption list
        // mentions any more is a reason written down for a risk that is gone,
        // and it reads as coverage. Same shape as compose-paths' VM_PROVIDED.
        const listed = new Set(ENTRIES.map((e) => e.value));
        for (const value of Object.keys(DELIBERATELY_ABSENT)) {
            expect({ value, stillListed: listed.has(value) }).toEqual({ value, stillListed: true });
        }
    });
});

describe('the mechanism itself', () => {
    it('balanced() stops at the MATCHING bracket, not the first one at column 0', () => {
        // The bug this replaced, verbatim in shape: a const whose closing
        // bracket is indented, followed by an `it` body containing a literal.
        const src = [
            'const FOO_ALLOWLIST = [',
            "    'src/a.ts',",
            '    ];',                       // indented close — a `^\]` regex misses it
            '',
            "it('self-test', () => {",
            "    scan('synthetic.tsx');",
            '});',
        ].join('\n');
        const open = src.indexOf('[');
        const body = balanced(src, open);
        expect(body).toBe("[\n    'src/a.ts',\n    ]");
        expect(body).not.toContain('synthetic.tsx');
    });

    it('balanced() does not end on a bracket inside a string or a comment', () => {
        const src = "const X_EXEMPT = [\n    'a]b.ts', // ] not the end\n    'c.ts',\n];";
        const body = balanced(src, src.indexOf('['));
        expect(body).toContain('c.ts');
    });

    it('balanced() returns null on an unterminated literal rather than a wrong slice', () => {
        expect(balanced("const Y_ALLOWED = [\n    'a.ts',", 18)).toBeNull();
    });

    it('a commented-out entry is NOT read as a live exemption', () => {
        // The bug the blanking fixes, and the reason this guard routes through
        // the shared stripper: without it, removing an entry by commenting it
        // out would make this guard report the removal as stale debt.
        // In tmpdir, not the repo: an interrupted run must not be able to
        // leave a stray file inside a directory this guard itself scans.
        const tmp = join(mkdtempSync(join(tmpdir(), 'exemption-scan-')), 'fixture.ts');
        writeFileSync(
            tmp,
            [
                'const FIXTURE_ALLOWLIST = [',
                "    // 'src/removed-last-year.ts',",
                "    'src/still-here.ts',",
                '];',
            ].join('\n'),
            'utf8',
        );
        try {
            const found = exemptionEntries([tmp]).map((e) => e.value);
            expect(found).toEqual(['src/still-here.ts']);
            expect(found).not.toContain('src/removed-last-year.ts');
        } finally {
            rmSync(join(tmp, '..'), { recursive: true, force: true });
        }
    });

    it('FILEISH requires a basename, so a bare extension is not a filename', () => {
        // The three findings the first version invented, pinned as non-findings.
        expect(FILEISH.test('.ts')).toBe(false);
        expect(FILEISH.test('.tsx')).toBe(false);
        expect(FILEISH.test('a.ts')).toBe(true);
        expect(FILEISH.test('assets/[id]/MaintenanceTab.tsx')).toBe(true);
        // A lockfile extension is not in the list, which is why `yarn.lock`
        // needs no deliberately-absent entry while `pnpm-lock.yaml` does.
        expect(FILEISH.test('yarn.lock')).toBe(false);
        expect(FILEISH.test('pnpm-lock.yaml')).toBe(true);
    });

    it('namesSomethingReal resolves relative entries and still fails a MOVED path', () => {
        // #2385 moved twelve guards out of tests/unit, which is what makes the
        // move case real rather than hypothetical — and what a basename-only
        // rule would be blind to.
        expect(namesSomethingReal('tests/guards/exemption-entries-name-something-real.test.ts')).toBe(true);
        expect(namesSomethingReal('tests/unit/no-direct-prisma.test.ts')).toBe(false);
        expect(namesSomethingReal('tests/guards/no-direct-prisma.test.ts')).toBe(true);
        expect(namesSomethingReal('tests/unit/practices-filter-defs.test.ts')).toBe(false);
    });

    it('EXEMPT_NAME selects by the constant NAME, and this file is a case in point', () => {
        expect(EXEMPT_NAME.test('REPO_ALLOWLIST')).toBe(true);
        expect(EXEMPT_NAME.test('SKIP_PATHS')).toBe(true);
        expect(EXEMPT_NAME.test('VM_PROVIDED')).toBe(true);
        expect(EXEMPT_NAME.test('ROOTS')).toBe(false);
        // DELIBERATELY_ABSENT is deliberately NOT exemption-named, so the scan
        // does not read this file's own escape hatch as part of the population.
        expect(EXEMPT_NAME.test('DELIBERATELY_ABSENT')).toBe(false);
    });
});
