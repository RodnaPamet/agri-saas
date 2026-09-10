import * as fs from 'fs';
import * as path from 'path';

/**
 * `docs/runbooks/production-vm.md` must stay a runbook someone can RUN.
 *
 * ── Why this file exists, and why it is not called what you expect ──
 *
 * The GAP-12 ratchet `tests/guardrails/k8s-runbook-coverage.test.ts`
 * asserted that `docs/deployment.md` "marks the Kubernetes/EKS path as
 * the primary production model". Twelve tests, entirely green, holding a
 * false claim in place: the EKS path never ran once, and production is
 * and always has been docker compose on a GCE VM. #840 deleted it and
 * replaced the framing half with `production-path-framing.test.ts`.
 *
 * #842 is the other half — the runbook itself. **This file is
 * deliberately NOT named `k8s-runbook-coverage`.** Copying that filename
 * onto a check that now guards a VM runbook would re-create the original
 * defect in its purest form: a name asserting a claim about the world
 * that stopped being true, with green tests underneath it.
 *
 * ── What it guards ──
 *
 * The four axes the deleted ratchet was right to want covered — deploy,
 * rollback, scaling, backup/restore — plus the property that makes a
 * runbook trustworthy at 03:00: **every repo path it names exists.** A
 * runbook that sends an operator to a script that is not there is the
 * same defect as a runbook that sends them to a cluster that is not
 * there, one level out. That check DERIVES its path list from the doc
 * rather than listing paths here, so a newly-added reference is covered
 * the moment it lands.
 *
 * ── UNBOUNDED-SLICE AUDIT, 2026-09-10 (third pass on #842) ──
 *
 * The banner test below read:
 *
 *     src().slice(0, src().indexOf('\n## 0.'))
 *
 * `indexOf` returns -1 for an absent anchor and `slice(0, -1)` is then
 * the WHOLE DOCUMENT minus one character, so its `length > 500`
 * positive control measured the runbook, not the banner: renaming
 * `## 0.` left the #854 "a human noticed" assertions green against
 * text taken from anywhere in the file. Every bounded selection in
 * this file now goes through an extractor that PROVES its anchors and
 * names the missing one — `preamble()` for a prefix, `between()` for a
 * span — and the extractors are unit-tested against a fixture rather
 * than trusted.
 *
 * Mutation-proved (#842): deleting the Rollback heading fails 3;
 * renaming `deploy/apply.sh` in the doc fails the path-existence test;
 * moving a `kubectl` command out of the "does not have" inventory and
 * into the Deploy section fails the confinement test.
 * Mutation-proved (third pass): renaming `## 0.` fails the banner test
 * by name; renaming `## 1. Deploy` fails the confinement tests by name.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const DOC = 'docs/runbooks/production-vm.md';

function readRepoFile(rel: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

/**
 * Where `anchor` starts — or a failure that NAMES it.
 *
 * `String.prototype.indexOf` answers -1 for an absent anchor, and every
 * slice built on -1 silently widens instead of failing: `slice(0, -1)`
 * is the whole document, `slice(-1)` is its last character. An
 * extraction that widens under mutation certifies nothing, so the index
 * is proved here, once, and nothing in this file slices without it.
 */
function anchorIndex(src: string, anchor: string): number {
    const at = src.indexOf(anchor);
    if (at === -1) {
        throw new Error(
            `${DOC}: anchor ${JSON.stringify(anchor)} is absent, so the ` +
                `selection it bounds cannot be taken. The heading was ` +
                `renamed or removed — update the doc and this guard ` +
                `together; do not slice an unlocated anchor.`,
        );
    }
    return at;
}

/** The section a heading opens, up to the next heading of the same level. */
function section(src: string, heading: string): string {
    const start = src.indexOf(heading);
    if (start === -1) return '';
    const rest = src.slice(start + heading.length);
    const next = rest.search(/\n## /);
    return next === -1 ? rest : rest.slice(0, next);
}

/** Everything BEFORE `anchor`, with `anchor` proved present. */
function preamble(src: string, anchor: string): string {
    return src.slice(0, anchorIndex(src, anchor));
}

/** The span from `from` up to `to`, with BOTH anchors proved present. */
function between(src: string, from: string, to: string): string {
    const start = anchorIndex(src, from);
    const end = anchorIndex(src, to);
    if (end <= start) {
        throw new Error(
            `${DOC}: ${JSON.stringify(to)} occurs at or before ` +
                `${JSON.stringify(from)} — the span is empty or inverted, ` +
                `which no assertion below can detect on its own.`,
        );
    }
    return src.slice(start, end);
}

describe('the extractors every scoped assertion in this file depends on', () => {
    // Unit-tested, not trusted. An extractor that returns '' — or, worse,
    // the whole document — makes every test downstream of it vacuous,
    // and that is the exact defect this file was corrected for twice.
    const FIXTURE = ['# T', 'intro', '## A', 'alpha', '## B', 'bravo'].join('\n');

    it('section() stops at the next same-level heading', () => {
        expect(section(FIXTURE, '\n## A')).toContain('alpha');
        expect(section(FIXTURE, '\n## A')).not.toContain('bravo');
    });

    it('section() returns empty for an absent heading, so callers must prove non-empty', () => {
        expect(section(FIXTURE, '\n## Nope')).toBe('');
    });

    it('preamble() takes only the text before the anchor', () => {
        expect(preamble(FIXTURE, '\n## A')).toContain('intro');
        expect(preamble(FIXTURE, '\n## A')).not.toContain('alpha');
    });

    it('preamble() throws by name instead of returning the whole document', () => {
        // The trap, demonstrated rather than described.
        expect(FIXTURE.slice(0, FIXTURE.indexOf('\n## Nope'))).toHaveLength(
            FIXTURE.length - 1,
        );
        expect(() => preamble(FIXTURE, '\n## Nope')).toThrow(/## Nope/);
    });

    it('between() bounds a span and throws by name for either missing anchor', () => {
        expect(between(FIXTURE, '\n## A', '\n## B')).toContain('alpha');
        expect(between(FIXTURE, '\n## A', '\n## B')).not.toContain('bravo');
        expect(() => between(FIXTURE, '\n## Nope', '\n## B')).toThrow(/## Nope/);
        expect(() => between(FIXTURE, '\n## A', '\n## Gone')).toThrow(/## Gone/);
    });
});

describe('production VM runbook — structure', () => {
    it('exists and is substantial — a truncated or emptied file must fail loudly', () => {
        // Positive control for the whole suite. Several assertions below
        // examine a SELECTION (a section, a set of extracted paths); an
        // empty selection is a pass in every tool that takes one.
        expect(fs.existsSync(path.join(REPO_ROOT, DOC))).toBe(true);
        const src = readRepoFile(DOC);
        expect(src.split('\n').length).toBeGreaterThan(250);
        expect(src).toMatch(/^# Runbook — Production VM/m);
    });

    it.each([
        ['deploy', /^## 1\. Deploy/m],
        ['rollback', /^## 2\. Rollback/m],
        ['scaling', /^## 3\. Scaling/m],
        ['backup/restore', /^## 4\. Backup & restore/m],
    ])('covers the %s axis as its own top-level section', (_label, re) => {
        expect(readRepoFile(DOC)).toMatch(re);
    });

    it('gives rollback a section, not a table row', () => {
        // #842's central point. Rollback is the axis a k8s runbook could
        // not have got right, because the code and the schema roll back
        // at different speeds here. A one-line summary cannot carry that.
        const rollback = section(readRepoFile(DOC), '\n## 2. Rollback');
        expect(rollback.length).toBeGreaterThan(2000);
    });
});

describe('production VM runbook — the rollback answers that are specific to this deployment', () => {
    const rollback = () => section(readRepoFile(DOC), '\n## 2. Rollback');

    it('states that shipping an image is what applies a migration', () => {
        // `scripts/entrypoint.sh` runs `prisma migrate deploy` before
        // Next.js starts. Everything else in the section follows from it.
        const s = rollback();
        expect(s).toMatch(/scripts\/entrypoint\.sh/);
        expect(s).toMatch(/prisma migrate deploy/);
    });

    it('warns that an image-only rollback leaves the schema migrated', () => {
        const s = rollback();
        expect(s).toMatch(/schema/i);
        expect(s).toMatch(/fails outright|does not degrade/i);
    });

    it('makes deploy/rollback/*.down.sql findable FROM the runbook', () => {
        // The scripts existing is not enough — an operator has to reach
        // them from the document they are already reading.
        const s = rollback();
        expect(s).toMatch(/deploy\/rollback\//);
        expect(s).toMatch(/deploy\/rollback\/README\.md/);
    });

    it('prices the snapshot fallback honestly (up to 24h), rather than implying a 1h target', () => {
        const s = rollback();
        expect(s).toMatch(/24\s*h/i);
        // The 1-hour RPO target was retired on 2026-09-10 (#842); it must
        // not reappear here, where it would be read as a promise about how
        // much data a snapshot restore costs.
        expect(s).not.toMatch(/RPO of (1|one) hour/i);
        expect(s).not.toMatch(/RPO[^.]{0,40}\b1\s*h(our)?\b/i);
    });

    it('says the incident was found by a human, not by a monitor (#854)', () => {
        // Nothing detects a production outage. A rollback section that
        // opens as if a page had fired teaches the reader a detection
        // time that does not exist.
        const s = rollback();
        expect(s).toMatch(/#854/);
        expect(s).toMatch(/a person noticed|a human notic|nothing paged/i);
    });

    it('tells the operator how to confirm which build is live', () => {
        // `/api/readyz` returns BUILD_SHA as `version`. Without a
        // verification step a rollback is an act of faith.
        const s = rollback();
        expect(s).toMatch(/\/api\/readyz/);
        expect(s).toMatch(/version/);
    });
});

describe('production VM runbook — it must not send anyone to infrastructure that does not exist', () => {
    const INVENTORY = '## What this deployment does not have';

    /**
     * The four axis sections — everything an operator follows as an
     * INSTRUCTION. The document's opening warning and its closing
     * inventory both name `helm` / `kubectl` / `aws` on purpose, to tell
     * the reader those are not available here; naming them there is the
     * opposite of the defect. Naming them between §1 and §4 is the defect.
     */
    function procedures(src: string): string {
        // Both anchors proved by `between()`. The previous spelling
        // returned '' when either was missing, and '' satisfies every
        // `not.toContain` below — a renamed §1 would have certified the
        // document clean of `helm`/`kubectl`/`aws` without reading a
        // word of it.
        return between(src, '\n## 1. Deploy', INVENTORY);
    }

    it('the "does not have" inventory exists, and the axis sections are non-empty', () => {
        // Positive control. Both halves: an absent inventory heading or a
        // renamed §1 would make `procedures()` empty, and an empty string
        // satisfies every `not.toContain` below silently.
        const src = readRepoFile(DOC);
        expect(src).toContain(INVENTORY);
        expect(section(src, '\n' + INVENTORY).length).toBeGreaterThan(500);
        expect(procedures(src).length).toBeGreaterThan(5000);
    });

    it.each(['helm', 'kubectl', 'aws '])(
        'never names `%s` inside the deploy/rollback/scaling/backup procedures',
        (token) => {
            expect(procedures(readRepoFile(DOC)).toLowerCase()).not.toContain(token);
        },
    );
});

describe('production VM runbook — every repo path it names exists', () => {
    // Derived, not listed. A path added to the doc tomorrow is covered
    // tomorrow, without touching this file.
    const PATH_RE = /(?:^|[\s`("[])((?:deploy|scripts|infra|docs|tests|src|prisma|\.github)\/[A-Za-z0-9_./*<>-]+)/g;

    function namedPaths(src: string): string[] {
        const out = new Set<string>();
        for (const m of src.matchAll(PATH_RE)) {
            // Strip markdown/prose trailing punctuation.
            const p = m[1].replace(/[`)\],.;:]+$/, '');
            if (p) out.add(p);
        }
        return [...out];
    }

    it('extracts a non-trivial set of paths — an extraction that finds nothing is not a pass', () => {
        // Positive control. `not.toBe(0)` here is what stops a broken
        // regex from certifying the doc as clean.
        expect(namedPaths(readRepoFile(DOC)).length).toBeGreaterThan(12);
    });

    it('resolves every one of them on disk', () => {
        const missing = namedPaths(readRepoFile(DOC)).filter((p) => {
            // Placeholders — `deploy/rollback/<name>.down.sql`,
            // `deploy/rollback/*.down.sql` — are checked at their
            // directory, which is the part the operator has to find.
            const target = /[*<]/.test(p) ? path.dirname(p) : p;
            return !fs.existsSync(path.join(REPO_ROOT, target));
        });
        expect(missing).toEqual([]);
    });
});

describe('production VM runbook — it does not imply a detection capability', () => {
    // #854: no uptime check, no alert, no pager, no rota. The runbook is
    // the document an operator opens at the start of an incident, so it
    // is where a false belief about detection would be formed.
    const src = () => readRepoFile(DOC);

    it('the opening banner states plainly that a human noticed', () => {
        // NOT `src().slice(0, src().indexOf('\n## 0.'))`. That spelling
        // stood here until 2026-09-10: with `## 0.` renamed it returned
        // the whole runbook, and every assertion below — including the
        // length control — passed on text from anywhere in the file.
        const banner = preamble(src(), '\n## 0.');
        // Positive control: the banner must exist and be substantial.
        expect(banner.length).toBeGreaterThan(500);
        // ...and it must be the BANNER, not the document: the section it
        // stops at must not have been dragged in with it.
        expect(banner).not.toMatch(/^## 1\. Deploy/m);
        expect(banner).toMatch(/#854/);
        expect(banner).toMatch(/a human noticed|a human notices|human noticing/i);
        expect(banner).toMatch(/no uptime check|no alert|nothing (here )?detects/i);
    });

    it('the "does not have" inventory names the detection gap and its issue', () => {
        const inventory = section(src(), '\n## What this deployment does not have');
        expect(inventory.length).toBeGreaterThan(500);
        expect(inventory).toMatch(/#854/);
        expect(inventory).toMatch(/Nothing pages anyone/i);
        expect(inventory).toMatch(/Detection today is a human noticing/i);
    });

    it('never quotes a detection or acknowledge time as if one were measured', () => {
        // A stated "detected within N minutes" anywhere in this document
        // would be fiction. The 4-hour RTO is allowed — it is a
        // time-to-restore budget, and SLO 7 says so.
        const s = src();
        expect(s).not.toMatch(/detect(ed|ion)[^.\n]{0,40}\b\d+\s*(minutes|mins|hours)\b/i);
        expect(s).not.toMatch(/acknowledge[^.\n]{0,30}\b15\s*minutes\b/i);
    });
});

describe('production VM runbook — it is reachable from the docs an operator lands on', () => {
    it.each([
        'docs/deployment.md',
        'docs/incident-response.md',
        'docs/slos.md',
        'CLAUDE.md',
    ])('%s links to it', (rel) => {
        expect(readRepoFile(rel)).toContain(DOC);
    });
});
