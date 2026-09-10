/**
 * Epic OI-3 — runbook + SLOs ratchet (final OI-3 layer).
 *
 * Locks both docs against drift AND asserts the alignment between
 * the docs and the underlying machinery shipped across OI-1/OI-2/OI-3:
 *
 *   - SLOs cover the 4 OI-3-spec targets (availability, read+write
 *     latency split, RPO, RTO 4h)
 *   - Each SLO references the metric/mechanism that powers it
 *   - Incident-response.md has the 7 required playbooks
 *   - Each playbook references the specific alert + dashboard +
 *     command path that drives it
 *   - The runbook's "Operational alignment" section names every
 *     prior epic's deliverable that it depends on
 *
 * ── RE-POINTED 2026-09-10 (#842) ──────────────────────────────────
 *
 * Three assertions in this file used to REQUIRE, by exact match, the
 * Helm-release rollback commands and the AWS RDS restore command — in
 * `docs/incident-response.md`, the document that is read DURING an
 * incident, and in `docs/slos.md`'s RTO scenarios. There is no chart
 * (deleted in #848), no Helm release, no cluster and no RDS. So the
 * suite was green, and correcting either doc would have turned it red:
 * exactly the GAP-12 shape #840 removed from `deployment.md`, one
 * document over.
 *
 * The reason these assertions exist is sound — an incident runbook
 * must contain a rollback playbook, and an RTO target must name the
 * mechanism that meets it. Only the answers were wrong. They now
 * assert the VM path AND the absence of the impossible instruction,
 * so drifting back is what turns them red.
 *
 * ── SCOPED 2026-09-10, second pass (#842 review) ───────────────────
 *
 * The re-point above was correct and still asserted nothing. Review
 * found `it('RTO scenarios reference the recovery levers…')` searching
 * the WHOLE of `docs/slos.md`: every string it looked for also occurs
 * in SLO 6 or in the summary table, so DELETING the entire
 * "### Recovery scenarios mapped to RTO" section left the suite green.
 * The neighbouring `not.toMatch` test had the same defect one level
 * down — `src.split('## SLO 7: RTO')[1]` has no upper bound, so it ran
 * to end-of-file and its `length > 1000` positive control was
 * measuring the rest of the document rather than the section.
 *
 * Two shapes were addressed there:
 *
 *   1. A test named after a SECTION extracts that section, via the
 *      `section()` helper below, which is bounded at the next heading
 *      of the same or higher level and is itself unit-tested.
 *   2. Every extraction asserts its selection is NON-EMPTY and
 *      substantial BEFORE the verdict assertions run. An empty
 *      selection is a pass in every matcher that takes one, so an
 *      unproved selection is an unproved test.
 *
 * ── THAT PASS CLAIMED TOO MUCH — CORRECTED 2026-09-10, third pass ──
 *
 * The previous revision of this header said "Both shapes are now gone
 * from this file", and the commit that wrote it repeated the claim.
 * **The claim was false.** The unbounded-slice shape survived INSIDE
 * the fix for it, at the one extraction in this file that takes a
 * PREFIX rather than a section:
 *
 *     src.slice(0, src.indexOf('\n## Quick reference'))
 *
 * `indexOf` returns -1 when the anchor is absent; `slice(0, -1)` is
 * then the WHOLE DOCUMENT minus its last character. So the stated
 * `banner.length > 500` positive control proved that the document had
 * a body, not that the banner had one, and renaming
 * `## Quick reference` left the banner test green — the same defect,
 * one line inside its own remedy.
 *
 * Prefix extraction now goes through `preamble()`, which captures the
 * index, REFUSES to slice when it is -1, and names the missing anchor
 * in the failure. Audited afterwards, deliberately rather than by
 * assertion: that was the last unbounded slice in this file.
 * `section()` is bounded and unit-tested, `preamble()` is unit-tested
 * including its -1 case, and every remaining `split()` here is a
 * whole-string `split('\n')` with no index taken off the end.
 *
 * Mutation-proved (#842 review): deleting
 * "### Recovery scenarios mapped to RTO" from `docs/slos.md` fails
 * this file (it passed before the fix); truncating the summary table
 * fails it; renaming `## 6. Rollback` in `docs/incident-response.md`
 * fails it.
 *
 * A green test is evidence the doc matches the assertion, never that
 * the assertion matches reality. These describe claims about the
 * world; re-check them against the world, not just against the doc.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

/**
 * The slice of `src` that `heading` opens, bounded at the next heading
 * of the same or higher level. Returns '' when the heading is absent —
 * every caller must prove the result non-empty before asserting on it.
 *
 * Only `##`-and-deeper headings terminate a section, never a bare
 * `# `: markdown fenced blocks in these docs are full of shell
 * comments (`# 1. Find the latest restorable time`), and treating one
 * as a heading truncates the section to the first code block.
 */
function section(src: string, heading: string): string {
    const start = src.indexOf(heading);
    if (start === -1) return '';
    const hashes = /^#+/.exec(heading.replace(/^\n+/, ''));
    const level = Math.max(2, hashes ? hashes[0].length : 2);
    const rest = src.slice(start + heading.length);
    const alternatives = [];
    for (let n = 2; n <= level; n++) alternatives.push('#'.repeat(n));
    const next = rest.search(new RegExp(`\\n(?:${alternatives.join('|')}) `));
    return next === -1 ? rest : rest.slice(0, next);
}

/**
 * The PREAMBLE of `src` — everything BEFORE `anchor` — with the anchor's
 * presence proved before anything is sliced.
 *
 * This exists because the obvious spelling is a tautology generator:
 * `src.slice(0, src.indexOf(anchor))` returns the whole document minus
 * one character when `anchor` is absent, which passes a length control,
 * passes every `toMatch` the real preamble would pass, and reports
 * nothing. Throwing — by name — is the only outcome that distinguishes
 * "the banner says X" from "somewhere in this file, X".
 */
function preamble(src: string, anchor: string): string {
    const at = src.indexOf(anchor);
    if (at === -1) {
        throw new Error(
            `preamble(): anchor ${JSON.stringify(anchor)} is absent from the ` +
                `document, so the text before it cannot be bounded. The ` +
                `heading was renamed or removed — update the doc and this ` +
                `guard together; do not slice an unlocated anchor.`,
        );
    }
    return src.slice(0, at);
}

/** Lines of a markdown table body/head — used as a positive control. */
const tableRows = (s: string) =>
    s.split('\n').filter((l) => l.trim().startsWith('|'));

describe('section() — the extractor every scoped assertion depends on', () => {
    // If this helper silently returns '' or swallows the rest of the
    // file, every test below it becomes a tautology. It is unit-tested
    // here rather than trusted, because that is the exact failure #842's
    // review found in the code this replaces.
    const DOC = [
        '## A',
        'alpha',
        '### A1',
        'alpha-one',
        '```bash',
        '# 1. a shell comment that is not a heading',
        '```',
        '## B',
        'bravo',
    ].join('\n');

    it('stops at the next heading of the same level', () => {
        expect(section(DOC, '## A')).toContain('alpha');
        expect(section(DOC, '## A')).not.toContain('bravo');
    });

    it('stops a subsection at the next subsection OR the next section', () => {
        expect(section(DOC, '### A1')).toContain('alpha-one');
        expect(section(DOC, '### A1')).not.toContain('bravo');
    });

    it('does not treat a `# ` shell comment inside a fence as a heading', () => {
        expect(section(DOC, '## A')).toContain('a shell comment');
    });

    it('returns empty for an absent heading, so callers must prove non-empty', () => {
        expect(section(DOC, '## Nope')).toBe('');
    });

    it('preamble() returns only the text before the anchor', () => {
        expect(preamble(DOC, '\n## B')).toContain('alpha');
        expect(preamble(DOC, '\n## B')).not.toContain('bravo');
    });

    it('preamble() throws, naming the anchor, rather than returning the document', () => {
        // The trap, demonstrated rather than described: an absent anchor
        // makes the naive spelling return everything but one character —
        // long, plausible, and an unconditional pass for any length
        // control or `toMatch` placed after it.
        expect(DOC.slice(0, DOC.indexOf('\n## Nope'))).toHaveLength(DOC.length - 1);
        expect(() => preamble(DOC, '\n## Nope')).toThrow(/## Nope/);
    });
});

describe('OI-3 — SLOs (docs/slos.md)', () => {
    const SLO_DOC = 'docs/slos.md';

    it('exists', () => {
        expect(exists(SLO_DOC)).toBe(true);
    });

    it('declares availability ≥ 99.9% (OI-3 spec)', () => {
        const src = read(SLO_DOC);
        // The existing SLO 1 (pre-OI-3) already covered availability.
        // Locked here so a future "simplify" PR can't drop the target.
        expect(src).toMatch(/99\.9\s*%/);
    });

    it('splits API latency into READS (<500ms) and WRITES (<1000ms) per OI-3 spec', () => {
        const src = read(SLO_DOC);
        expect(src).toMatch(/SLO 2:\s*API Latency\s*[—-]\s*Reads/i);
        expect(src).toMatch(/SLO 2b:\s*API Latency\s*[—-]\s*Writes/i);
        // Read target
        expect(src).toMatch(/95th percentile of GET requests\s*<\s*500ms/i);
        // Write target
        expect(src).toMatch(/95th percentile of state-mutating requests\s*<\s*1000ms/i);
    });

    it('read latency formula filters by GET|HEAD method, inside SLO 2', () => {
        const slo2 = section(read(SLO_DOC), '## SLO 2: API Latency');
        expect(slo2).not.toBe('');
        expect(slo2.length).toBeGreaterThan(800);
        expect(slo2).toMatch(/http_method=~"GET\|HEAD"/);
    });

    it('write latency formula filters by mutating methods, inside SLO 2b', () => {
        const slo2b = section(read(SLO_DOC), '## SLO 2b: API Latency');
        expect(slo2b).not.toBe('');
        expect(slo2b.length).toBeGreaterThan(800);
        expect(slo2b).toMatch(/http_method=~"POST\|PUT\|PATCH\|DELETE"/);
    });

    it('declares RPO 24 hours — the objective a daily snapshot delivers', () => {
        // #842. The objective was RESTATED from 1 hour to 24 hours by
        // the product owner. That retires an unfunded target; it does
        // not correct a lie — `docs/slos.md` already disclosed the 24h
        // achieved figure. The point of asserting on the OBJECTIVE
        // subsection specifically is that "24 hours" appears all over
        // SLO 6 as the achieved number, so a doc-wide match here would
        // stay green if the objective drifted back to 1 hour.
        const src = read(SLO_DOC);
        expect(src).toMatch(/SLO 6:\s*RPO/i);
        const slo6 = section(src, '## SLO 6: RPO');
        expect(slo6).not.toBe('');
        expect(slo6.length).toBeGreaterThan(2500);
        const objective = section(slo6, '### Objective');
        expect(objective).not.toBe('');
        expect(objective.length).toBeGreaterThan(200);
        expect(objective).toMatch(/Maximum\s+24\s+hours\s+of\s+data\s+loss/i);
        expect(objective).not.toMatch(/Maximum\s+1\s+hour\s+of\s+data\s+loss/i);
    });

    it('declares RTO 4 hours (OI-3 spec)', () => {
        const src = read(SLO_DOC);
        expect(src).toMatch(/SLO 7:\s*RTO/i);
        expect(src).toMatch(/Service\s+restored\s+within\s+4\s+hours/i);
    });

    it('RPO keeps the retired 1-hour target visible as history, not as a target', () => {
        const slo6 = section(read(SLO_DOC), '## SLO 6: RPO');
        // Positive control before any verdict.
        expect(slo6).not.toBe('');
        expect(slo6.length).toBeGreaterThan(2500);

        // #842. Restating the objective down to what the deployment
        // delivers is only honest if the trail stays legible. Deleting
        // the history would turn a retired commitment into a target
        // that had simply always been 24 hours — which is the kind of
        // edit this whole epic exists to make impossible.
        expect(slo6).toMatch(/retired/i);
        expect(slo6).toMatch(/NOT MET|not met/);
        expect(slo6).toMatch(/2026-04-27/); // 1h target written (against RDS)
        expect(slo6).toMatch(/2026-08-01/); // the day any backup first existed
        expect(slo6).toMatch(/2026-09-10/); // the day the target was retired
        // The deployment did not change on the day the number did, and
        // the doc has to say so — otherwise the restatement reads as a
        // fix that shipped nothing.
        expect(slo6).toMatch(/nothing about the deployment changed/i);
        // The achieved figure, unchanged throughout.
        expect(slo6).toMatch(/up to\s+\*?\*?24\*?\*?\s*h(ours)?|24h/i);
        // And what closing the gap would take, so "why is this still
        // open?" is answerable without re-deriving it.
        expect(slo6).toMatch(/WAL|continuous archiving|managed Postgres/);
    });

    it('RPO is verified by the monthly restore drill', () => {
        const src = read(SLO_DOC);
        // The restore script (OI-3 part 4, re-pointed to GCP on
        // 2026-08-01) is the canonical verification mechanism; a SLO
        // doc that doesn't cite it would mean the SLO is a number on
        // paper, not a measured commitment.
        expect(src).toMatch(/restore-test(-gcp)?\.sh/);
    });

    it('RTO scenarios reference the recovery levers this deployment actually has', () => {
        // #842 review: this test used to search the WHOLE document and
        // so asserted nothing about the section it is named after — a
        // reviewer deleted "### Recovery scenarios mapped to RTO"
        // outright and it stayed green, because `deploy/apply.sh`,
        // `agrent-daily-snapshot` and the runbook path all appear in
        // SLO 6 and in the summary table too.
        const scenarios = section(
            read('docs/slos.md'),
            '### Recovery scenarios mapped to RTO',
        );
        // Positive control: an absent, renamed or emptied section fails
        // HERE, loudly, instead of sailing through the matches below.
        expect(scenarios).not.toBe('');
        expect(scenarios.length).toBeGreaterThan(800);
        // It has to be the SCENARIO TABLE, not a sentence promising one.
        expect(scenarios).toMatch(
            /\|\s*Scenario\s*\|\s*Mechanism\s*\|\s*Estimated RTO\s*\|/,
        );
        // Header + separator + one row per scenario.
        expect(tableRows(scenarios).length).toBeGreaterThanOrEqual(8);

        // was `helm rollback` + `restore-db-instance`. Neither exists.
        // The three real levers, worst case last:
        expect(scenarios).toMatch(/deploy\/apply\.sh/);
        expect(scenarios).toMatch(
            /deploy\/rollback\/\*?\.?down\.sql|deploy\/rollback\/<migration>\.down\.sql/,
        );
        expect(scenarios).toMatch(/agrent-daily-snapshot/);
        // ...and the runbook that carries the procedures.
        expect(scenarios).toMatch(/docs\/runbooks\/production-vm\.md/);
        // The snapshot row must price itself at the real RPO.
        expect(scenarios).toMatch(/24\s*h/i);
    });

    it('RTO scenarios do NOT instruct an operator toward a cluster or an AWS account', () => {
        const rto = section(read('docs/slos.md'), '## SLO 7: RTO');
        // Positive control: the section must exist and be substantial,
        // or every `not.toMatch` below passes vacuously.
        expect(rto).not.toBe('');
        expect(rto.length).toBeGreaterThan(1500);
        // ...and it must be BOUNDED. The previous version of this test
        // sliced with `split('## SLO 7: RTO')[1]`, which ran to
        // end-of-file: the length control above then proved only that
        // the document had a tail, not that SLO 7 had a body.
        expect(rto).not.toMatch(/## SLO Summary Table/);
        expect(rto).not.toMatch(/## Revision History/);

        // The runnable falsehoods. A prose mention inside the
        // correction note is fine and deliberate; a COMMAND is not.
        expect(rto).not.toMatch(/`?helm rollback`?\s/);
        expect(rto).not.toMatch(/restore-db-instance/);
        expect(rto).not.toMatch(/aws secretsmanager/);
    });

    it('SLO 7 states that detection is uninstrumented and names the issue tracking it', () => {
        // #854 — nothing detects a production outage: no monitoring, no
        // alerting, no pager, no uptime check. An RTO that silently
        // assumes a 15-minute acknowledge is an RTO measured from a
        // moment nobody observes.
        const rto = section(read('docs/slos.md'), '## SLO 7: RTO');
        expect(rto).not.toBe('');
        expect(rto.length).toBeGreaterThan(1500);
        expect(rto).toMatch(/#854/);
        expect(rto).toMatch(/human noticing|someone notices|a human next looks/i);
        expect(rto).toMatch(/not instrumented|uninstrumented|unbounded/i);
    });

    it('declares the repository SLO that uses OI-3 part 2 metrics', () => {
        const src = read('docs/slos.md');
        expect(src).toMatch(/SLO 5:\s*Repository latency/i);
        // The metric name from OI-3 part 2
        expect(src).toMatch(/repo_method_duration/);
    });

    it('summary table contains all 8 SLOs (4 original + read/write split + repo + RPO + RTO)', () => {
        // #842 review: was an unbounded `split('## SLO Summary Table')[1]`,
        // i.e. the whole tail of the document. `toContain` against the
        // tail would have been satisfied by any later mention of a
        // target name, table or no table.
        const summary = section(read('docs/slos.md'), '## SLO Summary Table');
        expect(summary).not.toBe('');
        expect(summary.length).toBeGreaterThan(500);
        expect(summary).not.toMatch(/## Load-Test Validation/);
        // Header + separator + 8 SLO rows.
        expect(tableRows(summary).length).toBeGreaterThanOrEqual(10);
        for (const target of [
            'API Availability',
            'API Latency — Reads',
            'API Latency — Writes',
            'API Error Rate',
            'Health Check Availability',
            'Repository Latency',
            'RPO (Recovery Point)',
            'RTO (Recovery Time)',
        ]) {
            expect(summary).toContain(target);
        }
    });

    it('summary table leads the RPO row with the objective that is met, not the retired one', () => {
        // #842. The summary table is what a reader skims instead of
        // reading SLO 6. It used to lead with "≤ 1 hour" and footnote
        // the 24h reality, which is the lie in miniature.
        const summary = section(read('docs/slos.md'), '## SLO Summary Table');
        expect(summary).not.toBe('');
        const rpoRow = summary
            .split('\n')
            .find((l) => l.includes('RPO (Recovery Point)'));
        expect(rpoRow).toBeDefined();
        expect(rpoRow).toMatch(/24\s*hours/i);
        expect(rpoRow).not.toMatch(/≤\s*1\s*hour/);
    });

    it('revision history records the OI-3 update and the #842 correction', () => {
        const history = section(read('docs/slos.md'), '## Revision History');
        expect(history).not.toBe('');
        expect(history.length).toBeGreaterThan(500);
        expect(history).toMatch(/2026-04-27.*OI-3/);
        expect(history).toMatch(/2026-09-10.*#842/);
    });
});

describe('OI-3 — Incident response runbook (docs/incident-response.md)', () => {
    const DOC = 'docs/incident-response.md';

    it('exists', () => {
        expect(exists(DOC)).toBe(true);
    });

    const REQUIRED_PLAYBOOKS = [
        ['App Down', 'app-down'],
        ['Database Unavailable', 'database-unavailable'],
        ['Redis OOM', 'redis-oom'],
        ['Queue Backlog', 'queue-backlog'],
        ['Certificate Expiry', 'certificate-expiry'],
        ['Rollback', 'rollback'],
        ['Data Breach Response', 'data-breach'],
    ] as const;

    it.each(REQUIRED_PLAYBOOKS)('contains the %s playbook', (label) => {
        const src = read(DOC);
        // Match "## <num>. <Label>" or "## <Label>"
        expect(src.toLowerCase()).toContain(label.toLowerCase());
    });

    it('quick-reference table maps every alert to a playbook', () => {
        const src = read(DOC);
        // Every alert from rules.yml that pages should appear in the
        // quick-reference. Lock the OI-3-spec alerts.
        for (const alert of [
            'DatabaseConnectionPoolExhausted',
            'RedisMemoryHighCritical',
            'RedisMemoryHighWarning',
            'QueueDepthBacklogCritical',
            'CertificateExpiryCritical',
        ]) {
            expect(src).toContain(alert);
        }
    });

    it('references the four OI-3 dashboards by UID', () => {
        const src = read(DOC);
        for (const uid of [
            'inflect-app-overview',
            'inflect-database',
            'inflect-redis',
            'inflect-bullmq',
        ]) {
            expect(src).toContain(uid);
        }
    });

    it('App Down playbook uses /api/livez (matches external uptime contract)', () => {
        const appDown = section(read(DOC), '\n## 1. App Down');
        expect(appDown).not.toBe('');
        expect(appDown.length).toBeGreaterThan(1500);
        // The playbook itself must instruct curl to /api/livez — the
        // endpoint an external uptime monitor would probe. Doc-wide
        // this matched from anywhere, including a different playbook.
        expect(appDown).toMatch(/curl[^`]*\/api\/livez/);
    });

    it('App Down playbook says plainly that detection is a human noticing', () => {
        // #854. The playbook opens the incident, so it is where the
        // reader forms their belief about how the incident was found.
        const appDown = section(read(DOC), '\n## 1. App Down');
        expect(appDown).not.toBe('');
        expect(appDown.length).toBeGreaterThan(1500);
        expect(appDown).toMatch(/human noticing|a human notices/i);
        expect(appDown).toMatch(/#854/);
    });

    it('Rollback playbook gives the VM rollback path, with the image tag and the apply script', () => {
        const rollback = section(read(DOC), '\n## 6. Rollback');
        // Positive control — an empty or renamed section must fail here,
        // not sail through the assertions below.
        expect(rollback).not.toBe('');
        expect(rollback.length).toBeGreaterThan(2000);
        // The image pin: which registry, which tag shape, applied how.
        expect(rollback).toMatch(/ghcr\.io\/rodnapamet\/agri-saas/);
        expect(rollback).toMatch(/sha-<short>|sha-\w+/);
        expect(rollback).toMatch(/deploy\/apply\.sh/);
        // The schema half — the reason a pin alone is not a rollback.
        expect(rollback).toMatch(/deploy\/rollback\//);
        // And how to tell whether you are on the intended build.
        expect(rollback).toMatch(/\/api\/readyz/);
    });

    it('Rollback playbook does NOT instruct on-call to roll back a Helm release', () => {
        const src = read(DOC);
        // #842 — the exact strings this file used to REQUIRE. There is
        // no chart, no release and no cluster for them to address, and
        // this is the document someone reads under time pressure.
        //
        // Deliberately doc-wide and scoped to the RUNNABLE
        // release-named form: a whole-document negative is STRICTER
        // than a section-scoped one, and the "Operational alignment"
        // table still names `helm rollback` in a struck-through
        // correction row, which is a record of what was wrong, not an
        // instruction. Sections 2-5 still carry uncorrected EKS triage
        // and are flagged by the doc's banner; they are tracked
        // separately, not silently tolerated here.
        expect(src).not.toMatch(/helm\s+(history|rollback)\s+inflect-production/);
    });

    it('Rollback playbook documents that an image rollback leaves the schema migrated', () => {
        const rollback = section(read(DOC), '\n## 6. Rollback');
        expect(rollback).not.toBe('');
        expect(rollback.length).toBeGreaterThan(2000);
        // expand-and-contract is THE mitigation. Without this the
        // rollback playbook is unsafe.
        expect(rollback.toLowerCase()).toMatch(/expand[\s-]and[\s-]contract/);
        // #842: the old alternation described a Helm pre-upgrade Job.
        // The real mechanism is the container entrypoint — which is
        // why shipping an image is what applies a migration, and why
        // pinning the image back does not un-apply it.
        expect(rollback).toMatch(/entrypoint\.sh/);
        expect(rollback).toMatch(/prisma migrate deploy/);
        expect(rollback).toMatch(/shipping an image is what applies a migration/i);
        expect(rollback).toMatch(/one-way|fails outright|NOT reverted/i);
    });

    it('Database Unavailable playbook covers PgBouncer pool inspection', () => {
        const db = section(read(DOC), '\n## 2. Database Unavailable');
        expect(db).not.toBe('');
        expect(db.length).toBeGreaterThan(1500);
        expect(db).toMatch(/SHOW POOLS/);
        expect(db).toMatch(/pgbouncer/i);
    });

    it('the uncorrected AWS/EKS triage sections are FLAGGED, and the real recovery path is reachable', () => {
        // #842 review. This test used to require, by exact match, that
        // the doc contain `aws rds restore-db-instance-to-point-in-time`
        // — an instruction against an RDS instance that has never
        // existed, in the document read during an incident. It was the
        // last of the GAP-12 ratchets in this file: correcting § 2
        // would have turned the suite red.
        //
        // The requirement worth keeping is that a reader who reaches
        // that command is TOLD it is not real, and can get to the path
        // that is. Section 2 itself is corrected separately; this is
        // what must hold until then.
        const src = read(DOC);
        // NOT `src.slice(0, src.indexOf(...))`. That spelling stood here
        // until 2026-09-10 and made the length control below vacuous:
        // see the third-pass note at the top of this file.
        const banner = preamble(src, '\n## Quick reference');
        expect(banner.length).toBeGreaterThan(500);
        // The banner names § 2-5 as describing infrastructure that is
        // not deployed...
        expect(banner).toMatch(/2\.\s*Database/);
        expect(banner).toMatch(/does not exist|not deployed/i);
        expect(banner).toMatch(/unverified/i);
        // ...and points at the runbook that carries the real commands.
        expect(banner).toMatch(/docs\/runbooks\/production-vm\.md/);
        expect(src).toMatch(/docs\/backup-restore\.md/);
    });

    it('Data Breach playbook references the hash-chained AuditLog (preserves evidence)', () => {
        const breach = section(read(DOC), '\n## 7. Data Breach Response');
        expect(breach).not.toBe('');
        expect(breach.length).toBeGreaterThan(1500);
        expect(breach).toMatch(/AuditLog/);
        expect(breach).toMatch(/hash-chained/i);
    });

    it('Data Breach playbook references the Epic B v1→v2 sweep for KEK rotation', () => {
        const breach = section(read(DOC), '\n## 7. Data Breach Response');
        expect(breach).not.toBe('');
        expect(breach.length).toBeGreaterThan(1500);
        // The KEK rotation runbook lives in epic-b-encryption.md;
        // the incident-response runbook MUST point at it (regenerating
        // the KEK without the sweep is a data-loss event).
        expect(breach).toMatch(/epic-b-encryption/);
        expect(breach).toMatch(/v1.{0,5}v2/i);
    });

    it('Communication templates section has 5 named templates', () => {
        const templatesSection = section(read(DOC), '\n## Communication templates');
        expect(templatesSection).not.toBe('');
        expect(templatesSection.length).toBeGreaterThan(2000);
        const templates = [
            'PagerDuty incident',
            'Status page update — initial',
            'Status page update — mitigation in progress',
            'Status page update — resolved',
            'Internal Slack — incident channel kickoff',
        ];
        for (const t of templates) {
            expect(templatesSection).toContain(t);
        }
        // Plus the customer-email templates (degradation + breach)
        expect(templatesSection).toMatch(/Customer email\s*[—-]\s*service degradation/);
        expect(templatesSection).toMatch(/Customer email\s*[—-]\s*confirmed data breach/);
    });

    it('Severity definitions table includes both CRITICAL and WARNING tiers', () => {
        const sev = section(read(DOC), '\n## Severity definitions');
        expect(sev).not.toBe('');
        expect(sev.length).toBeGreaterThan(200);
        expect(sev).toMatch(/CRITICAL[\s\S]{0,200}PagerDuty/);
        expect(sev).toMatch(/WARNING[\s\S]{0,200}Slack/);
    });

    it('Severity definitions do NOT present the 15-minute acknowledge as a real budget', () => {
        // #854. The table's 15-minute acknowledge and its 4-hour
        // resolution budget are both routed through a PagerDuty service
        // that does not exist. Keeping the table is fine — it is the
        // intended policy — but it must not read as a description of
        // what happens today.
        const sev = section(read(DOC), '\n## Severity definitions');
        expect(sev).not.toBe('');
        expect(sev.length).toBeGreaterThan(200);
        expect(sev).toMatch(/#854/);
        expect(sev).toMatch(/not deployed|does not exist|nothing pages/i);
    });

    it('Operational alignment section names every prior-epic deliverable', () => {
        const alignment = section(read(DOC), '\n## Operational alignment summary');
        expect(alignment).not.toBe('');
        expect(alignment.length).toBeGreaterThan(500);
        // The closing section MUST call out the dependencies so an
        // operator reading this doc cold sees the system map.
        expect(alignment).toMatch(/Epic OI-1/);
        expect(alignment).toMatch(/Epic OI-2/);
        expect(alignment).toMatch(/Epic OI-3/);
        // Specific deliverables. The restore drill is
        // `restore-test-gcp.sh` since 2026-08-01 — the AWS RDS script
        // it replaced named infrastructure this product never ran (see
        // tests/guards/oi-3-backup-restore.test.ts and
        // docs/backup-restore.md).
        expect(alignment).toMatch(/restore-test-gcp\.sh/);
        expect(alignment).toMatch(/manage_master_user_password/);
        expect(alignment).toMatch(/external-uptime\.yml/);
    });
});

describe('OI-3 — final readiness check (alignment)', () => {
    it('every alert with severity=critical has a corresponding playbook section', () => {
        const runbookSrc = read('docs/incident-response.md');
        const rulesSrc = read('infra/alerts/rules.yml');

        // Walk the rules YAML for critical alerts
        const criticalNames: string[] = [];
        const lines = rulesSrc.split('\n');
        let pendingAlert: string | null = null;
        for (const line of lines) {
            const alertMatch = line.match(/^\s*-\s*alert:\s*(\w+)/);
            if (alertMatch) {
                pendingAlert = alertMatch[1];
                continue;
            }
            if (pendingAlert && /severity:\s*critical/.test(line)) {
                criticalNames.push(pendingAlert);
                pendingAlert = null;
            }
        }
        expect(criticalNames.length).toBeGreaterThan(0);

        // Subset of criticals that must each be addressed in the runbook.
        // (Not every critical has a unique section — e.g. ApiP95LatencyCritical
        // is handled inside the Database playbook. We assert the
        // OI-3-spec criticals are referenced by NAME in the doc.)
        const MUST_BE_NAMED = [
            'DatabaseConnectionPoolExhausted',
            'RedisMemoryHighCritical',
            'QueueDepthBacklogCritical',
            'CertificateExpiryCritical',
        ];
        for (const name of MUST_BE_NAMED) {
            expect(criticalNames).toContain(name);
            expect(runbookSrc).toContain(name);
        }
    });

    it('SLO doc references the alert names that protect each SLO', () => {
        const src = read('docs/slos.md');
        // Latency SLO ↔ ApiP95Latency alerts; Error rate SLO ↔ ApiErrorRate alerts
        expect(src).toMatch(/ApiP95LatencyWarning/);
        expect(src).toMatch(/ApiP95LatencyCritical/);
    });

    it('runbook references the dashboards UIDs that each alert uses', () => {
        const runbook = read('docs/incident-response.md');
        const rules = read('infra/alerts/rules.yml');

        // Extract every `dashboard:` annotation value from rules.yml
        const annotated = Array.from(
            rules.matchAll(/dashboard:\s*"([^"]+)"/g),
            (m) => m[1],
        );
        const uniqueUids = new Set(
            annotated
                .map((url) => {
                    const m = url.match(/^\/d\/([^/]+)/);
                    return m ? m[1] : '';
                })
                .filter((u) => u),
        );
        // An extraction that finds nothing certifies nothing.
        expect(uniqueUids.size).toBeGreaterThan(0);

        for (const uid of uniqueUids) {
            // The runbook should mention every dashboard the alerts
            // route operators to.
            expect(runbook).toContain(uid);
        }
    });
});
