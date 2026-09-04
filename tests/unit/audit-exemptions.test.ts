/**
 * scripts/audit-exemptions.mjs — the gate that judges the captured
 * `npm audit` report in CI. (It used to run only as the RHS of
 * `npm audit … || node scripts/audit-exemptions.mjs`; CI now captures one
 * report and hands it these exact bytes, because everything below sat
 * behind a `||` that a blind registry never reaches.)
 *
 * Exercised exclusively by spawning the script as a subprocess (same
 * convention as `tests/unit/sync-chart-version.test.ts` for
 * `sync-chart-version.mjs`, the repo's other `import.meta.url`-guarded CLI
 * script) — ts-jest's CommonJS transform doesn't support `import.meta`, so a
 * direct `import` of this module fails with "Cannot use import statement
 * outside a module" regardless of which export is consumed.
 *
 * Three env vars drive it:
 *   - `AUDIT_JSON_OVERRIDE` — the report to judge. NOT test-only any more:
 *     CI captures one `npm audit --json` to a file and points the script at
 *     it, so the tested path and the production path are the SAME path.
 *   - `EXEMPT_OVERRIDE` — a fixture replacing the (empty) real `EXEMPT`
 *     list. Test-only.
 *   - `AUDIT_CANARY_OVERRIDE` — the advisory-feed positive control.
 *     Test-only; without it the script makes a real network call.
 *
 * The last two are test-only levers that would disarm the gate if set in
 * CI, so `tests/guards/audit-gate-no-ci-overrides.test.ts` fails the build
 * if either name appears anywhere under `.github/`.
 *
 * Rules covered here:
 *   1-3  no exemption / stale exemption      (pre-existing)
 *   4    review-date expiry                  (the check this file began as)
 *   5    the report must BE a report, over a real tree, from a live feed
 *   6    an advisory we cannot NAME is not one we may drop
 *   7    the report file may be empty, truncated or not JSON at all
 *
 * Rules 5-7 exist because this gate spent an unknown period printing
 * "✓ every remaining moderate+ advisory is tracked and exempt" while
 * checking nothing: npm writes its ERRORS to stdout as valid JSON, and
 * `report.vulnerabilities ?? {}` turned "could not check" into "found
 * nothing". Several of the fixtures below are npm's REAL captured output
 * rather than hand-written approximations, because the bug was precisely in
 * what npm actually emits.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../scripts/audit-exemptions.mjs');

interface AuditVuln {
    severity: string;
    via: Array<{ url: string } | string>;
}

interface ExemptEntry {
    id: string;
    package: string;
    reason: string;
    review: string;
}

function auditReport(vulnerabilities: Record<string, AuditVuln>) {
    // `auditReportVersion` and `metadata` are NOT decoration. A real
    // `npm audit --json` report always carries them, and the script now
    // requires them — because npm writes its ERRORS to stdout as valid JSON
    // too, and `{vulnerabilities: {}}`-by-omission was indistinguishable from
    // "checked, found nothing". These fixtures previously modelled a shape
    // npm never emits, which is why they could not have caught the fail-open.
    //
    // `dependencies.total` must be non-zero for the same reason it is the
    // script's positive control: a report over an EMPTY tree also says
    // `vulnerabilities: {}`, so a fixture with total 0 would be asserting
    // against a state the script (correctly) refuses.
    return {
        auditReportVersion: 2,
        metadata: {
            vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
            dependencies: { prod: 882, dev: 1074, optional: 192, peer: 38, total: 2097 },
        },
        vulnerabilities,
    };
}

/** One blocking-severity advisory, shaped like a real `npm audit --json` entry. */
function advisory(ghsaId: string, severity = 'moderate'): AuditVuln {
    return { severity, via: [{ url: `https://github.com/advisories/${ghsaId}` }] };
}

function runScript(opts: {
    // `unknown`, not `ReturnType<typeof auditReport>` — the fail-closed cases
    // below deliberately feed payloads that are NOT audit reports, which is
    // the whole point of them.
    audit: unknown;
    exempt: ExemptEntry[];
    /**
     * The advisory-feed positive control. Defaults to `'live'` so these
     * tests stay hermetic — without it the script makes a real network call
     * to prove the feed is answering, which would make every clean-report
     * assertion depend on npm's uptime. Pass `'blind'` to exercise the
     * refusal.
     */
    canary?: 'live' | 'blind';
}): { code: number | null; stdout: string; stderr: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'audit-exemptions-'));
    const auditPath = path.join(dir, 'audit.json');
    const exemptPath = path.join(dir, 'exempt.json');
    writeFileSync(auditPath, JSON.stringify(opts.audit));
    writeFileSync(exemptPath, JSON.stringify(opts.exempt));
    try {
        const result = spawnSync('node', [SCRIPT], {
            env: {
                ...process.env,
                AUDIT_JSON_OVERRIDE: auditPath,
                EXEMPT_OVERRIDE: exemptPath,
                AUDIT_CANARY_OVERRIDE: opts.canary ?? 'live',
            },
            encoding: 'utf8',
        });
        return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** `review` days from today, formatted `YYYY-MM-DD` (UTC). */
function daysFromToday(days: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

describe('scripts/audit-exemptions.mjs', () => {
    // ─── Baseline: rules 1-3 (unchanged behaviour) ────────────────────

    it('exits 0 when there are no blocking advisories and no exemptions', () => {
        const result = runScript({ audit: auditReport({}), exempt: [] });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('every remaining moderate+ advisory is tracked and exempt');
    });

    it('exits 1 with "NO exemption" for a blocking advisory nobody exempted', () => {
        const result = runScript({
            audit: auditReport({ 'left-pad': advisory('GHSA-aaaa-aaaa-aaaa') }),
            exempt: [],
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('NO exemption');
        expect(result.stderr).toContain('GHSA-aaaa-aaaa-aaaa');
    });

    it('exits 1 with "STALE" when an exemption\'s advisory no longer appears', () => {
        const result = runScript({
            audit: auditReport({}),
            exempt: [
                {
                    id: 'GHSA-bbbb-bbbb-bbbb',
                    package: 'left-pad',
                    reason: 'upstream unreachable in prod',
                    review: daysFromToday(30),
                },
            ],
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('STALE');
        expect(result.stderr).toContain('GHSA-bbbb-bbbb-bbbb');
    });

    // ─── Rule 4: review-date expiry (the fix under test) ──────────────

    it('exits 0 when the exemption still covers its advisory and review is in the FUTURE', () => {
        const result = runScript({
            audit: auditReport({ 'left-pad': advisory('GHSA-cccc-cccc-cccc') }),
            exempt: [
                {
                    id: 'GHSA-cccc-cccc-cccc',
                    package: 'left-pad',
                    reason: 'reachable only via a dev-only build step, never bundled to prod',
                    review: daysFromToday(30),
                },
            ],
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('GHSA-cccc-cccc-cccc');
    });

    it('exits 1 with "EXPIRED" when the exemption still covers its advisory but review is in the PAST', () => {
        const result = runScript({
            audit: auditReport({ 'left-pad': advisory('GHSA-dddd-dddd-dddd') }),
            exempt: [
                {
                    id: 'GHSA-dddd-dddd-dddd',
                    package: 'left-pad',
                    reason: 'reachable only via a dev-only build step, never bundled to prod',
                    review: daysFromToday(-1),
                },
            ],
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('EXPIRED');
        expect(result.stderr).toContain('GHSA-dddd-dddd-dddd');
        // Tells the operator what to do next, not just that it failed.
        expect(result.stderr).toContain('Re-argue the exemption');
    });

    it('an expired entry is reported as EXPIRED, not STALE — its advisory still exists', () => {
        const result = runScript({
            audit: auditReport({ 'left-pad': advisory('GHSA-eeee-eeee-eeee') }),
            exempt: [
                {
                    id: 'GHSA-eeee-eeee-eeee',
                    package: 'left-pad',
                    reason: 'reachable only via a dev-only build step, never bundled to prod',
                    review: daysFromToday(-1),
                },
            ],
        });
        expect(result.stderr).toContain('EXPIRED');
        expect(result.stderr).not.toContain('STALE');
    });

    it('review date of TODAY has not yet expired (due today, not overdue)', () => {
        const result = runScript({
            audit: auditReport({ 'left-pad': advisory('GHSA-ffff-ffff-ffff') }),
            exempt: [
                {
                    id: 'GHSA-ffff-ffff-ffff',
                    package: 'left-pad',
                    reason: 'reachable only via a dev-only build step, never bundled to prod',
                    review: daysFromToday(0),
                },
            ],
        });
        expect(result.code).toBe(0);
    });

    // ─── Rule 4: a non-report must NEVER read as "clean" ──────────────
    //
    // `npm audit --json` writes its ERRORS to stdout as valid JSON. When
    // npm's advisory endpoint answered 400, `JSON.parse` succeeded, the
    // script's `report.vulnerabilities ?? {}` collapsed to `{}`, and it
    // exited 0 printing "every remaining moderate+ advisory is tracked and
    // exempt" — asserting safety while checking nothing. CI compounds it:
    // `npm audit ... || node scripts/audit-exemptions.mjs` runs this script
    // EXACTLY when audit fails.
    //
    // These use npm's REAL captured payload, not a hand-written
    // approximation, because the bug was in what npm actually emits.

    it('REFUSES npm real endpoint-error payload instead of reporting clean', () => {
        const payload = JSON.parse(
            readFileSync(path.resolve(__dirname, '../fixtures/npm-audit/endpoint-error-400.json'), 'utf8'),
        );
        const result = runScript({ audit: payload, exempt: [] });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('did not return a report');
        // The distinction that was erased: it must not claim cleanliness.
        expect(result.stderr).not.toContain('tracked and exempt');
        expect(result.stdout).not.toContain('tracked and exempt');
    });

    it.each([
        ['an empty object', {}],
        ['a bare error object', { error: { code: 'ENOAUDIT', summary: 'x', detail: '' } }],
        ['a report with no auditReportVersion', { vulnerabilities: {} }],
        ['vulnerabilities set to null', { auditReportVersion: 2, vulnerabilities: null }],
        ['a JSON array', []],
        ['a JSON string', 'not a report'],
    ])('REFUSES %s', (_label, payload) => {
        const result = runScript({ audit: payload, exempt: [] });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('did not return a report');
    });

    it('still accepts a genuinely CLEAN report — absence and emptiness differ', () => {
        // The whole fix rests on this being distinguishable. Measured: a real
        // clean `npm audit --json` CARRIES `vulnerabilities: {}` (present and
        // empty) alongside `auditReportVersion` and `metadata`. If a clean
        // report omitted the key, the check above would redden every run.
        const result = runScript({ audit: auditReport({}), exempt: [] });
        expect(result.code).toBe(0);
    });

    it('REFUSES a well-formed report that examined NO dependencies', () => {
        // The positive control, and the case the shape check alone cannot
        // see: this payload is a VALID report — right version, right keys,
        // `vulnerabilities: {}` — over an empty tree. "Zero advisories" and
        // "zero packages examined" are byte-identical in the vulnerabilities
        // field and mean opposite things.
        const result = runScript({
            audit: {
                auditReportVersion: 2,
                metadata: {
                    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
                    // Measured from a real zero-dependency audit: total is 0,
                    // prod is 1 (the root package itself).
                    dependencies: { prod: 1, dev: 0, optional: 0, peer: 0, total: 0 },
                },
                vulnerabilities: {},
            },
            exempt: [],
        });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('examined NO dependencies');
        expect(result.stderr).not.toContain('tracked and exempt');
    });

    it('REFUSES a report whose metadata is missing entirely', () => {
        const result = runScript({
            audit: { auditReportVersion: 2, vulnerabilities: {} },
            exempt: [],
        });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('examined NO dependencies');
    });

    // ─── Rule 5: the advisory feed's own positive control ─────────────

    it('REFUSES a clean report when the advisory feed cannot be shown to be live', () => {
        // `{}` is unfalsifiable on its own: measured against the real
        // registry, the bulk endpoint answers `200 {}` for an unknown
        // package — byte-identical to a package with no advisories. And
        // arborist writes the report shape and metadata counters
        // unconditionally, before any advisory data is consulted, so a BLIND
        // report over a 2000-package tree is byte-identical to a clean one.
        // Only external ground truth separates them.
        const result = runScript({ audit: auditReport({}), exempt: [], canary: 'blind' });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('advisory feed did not return a known-good result');
        expect(result.stderr).not.toContain('tracked and exempt');
        // Must not be mistaken for a finding, or the next person "fixes" it
        // by deleting the probe.
        expect(result.stderr).toContain('does NOT mean a vulnerability was found');
    });

    it('does NOT consult the feed when advisories were found — the report proves it', () => {
        // A report that CONTAINS advisories has already demonstrated a live
        // feed by existing, so the probe is unnecessary there. `blind` must
        // not change the verdict.
        const result = runScript({
            audit: auditReport({ 'left-pad': advisory('GHSA-1111-1111-1111') }),
            exempt: [],
            canary: 'blind',
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('NO exemption');
        expect(result.stderr).not.toContain('advisory feed');
    });

    // ─── Rule 6: an advisory we cannot NAME is not an advisory we can drop ─

    it('REFUSES a blocking advisory whose via carries no GHSA url', () => {
        // Shape-valid, metadata-consistent, and previously INVISIBLE:
        // `findAdvisories` only recorded `via` entries with a GHSA-matching
        // url, so a plausible npm shape drift (or a non-GHSA source) made a
        // real advisory vanish and the report read as fully exempted.
        const result = runScript({
            audit: auditReport({
                'left-pad': { severity: 'critical', via: [{ url: 'https://example.invalid/advisory/123' }] },
            }),
            exempt: [],
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('NO exemption');
        expect(result.stderr).toContain('UNNAMED:left-pad');
    });

    it('REFUSES a blocking advisory whose via entries are bare strings', () => {
        const result = runScript({
            audit: auditReport({ 'left-pad': { severity: 'high', via: ['some-other-package'] } }),
            exempt: [],
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('UNNAMED:left-pad');
    });

    // ─── Rule 7: the report file itself may be unusable ────────────────

    it.each([
        ['an EMPTY file', ''],
        ['a TRUNCATED json document', '{"auditReportVersion":2,"vulner'],
        ['plain text (an HTML proxy error, say)', '<html>502 Bad Gateway</html>'],
    ])('REFUSES %s', (_label, raw) => {
        // CI now captures the report with `> audit.json || true`, so the file
        // is whatever npm managed to write. An exception here must not fall
        // back into "no vulnerabilities key => nothing blocking".
        const dir = mkdtempSync(path.join(tmpdir(), 'audit-raw-'));
        const auditPath = path.join(dir, 'audit.json');
        writeFileSync(auditPath, raw);
        try {
            const result = spawnSync('node', [SCRIPT], {
                env: { ...process.env, AUDIT_JSON_OVERRIDE: auditPath, AUDIT_CANARY_OVERRIDE: 'live' },
                encoding: 'utf8',
            });
            expect(result.status).not.toBe(0);
            expect(`${result.stderr}`).toContain('UNUSABLE');
            expect(`${result.stdout}`).not.toContain('tracked and exempt');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // ─── End-to-end against the real (currently empty) EXEMPT list ────

    it('the real script, unmodified, produces a definite verdict against the live gate', () => {
        // Was: `expect(result.status).toBe(0)`. That assertion was both a
        // victim and an accomplice.
        //
        //  · VICTIM — it is a live third-party network call inside a fixed
        //    budget. When npm's endpoint HUNG, spawnSync was signal-killed,
        //    `status` came back `null`, and unrelated PRs went red.
        //  · ACCOMPLICE — once the endpoint answered 400 promptly, the script
        //    exited 0 BY FAILING OPEN, so this test would have gone green and
        //    certified the broken behaviour.
        //
        // So it no longer asserts a bare 0. Exit 0 means clean; a refusal
        // means the audit could not run, which is infrastructure and is
        // reported as a visible banner rather than silently tolerated. What
        // it must never do is pass while the script claims cleanliness it did
        // not establish.
        const result = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 120_000 });
        const out = `${result.stdout || ''}${result.stderr || ''}`;
        // Key on the ONE marker every "could not check" path prints, not on
        // any single message. An earlier version of this line matched a
        // specific string — and a later commit added new refusal wording,
        // so this test went red in CI on the very PR that fixed the bug it
        // was written for. `unusable()` is the single funnel; use its banner.
        const unreachable = result.status === null || out.includes('npm audit is UNUSABLE');

        if (unreachable) {
            const why = result.status === null ? 'timed out / signal-killed' : 'npm returned a non-report';
            const banner = `[audit-canary] LIVE GATE NOT EXERCISED — ${why}.`;
            if (process.env.AUDIT_CANARY_REQUIRE_NETWORK === '1') {
                throw new Error(`${banner}\n${out}`);
            }
            // Never silent: a skipped check must not look like a passing one.
            console.warn(`${banner} Set AUDIT_CANARY_REQUIRE_NETWORK=1 to make this a failure.`);
            expect(unreachable).toBe(true);
            return;
        }

        if (result.status !== 0) {
            // A real advisory or an expired exemption — surface it.
            console.error(result.stdout, result.stderr);
        }
        expect(result.status).toBe(0);
        expect(out).not.toContain('npm audit is UNUSABLE');
    }, 130_000);
});
