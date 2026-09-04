/**
 * scripts/audit-exemptions.mjs — the per-advisory exemption gate that runs
 * when `npm audit --omit=dev --audit-level=moderate` fails in CI.
 *
 * Exercised exclusively by spawning the script as a subprocess (same
 * convention as `tests/unit/sync-chart-version.test.ts` for
 * `sync-chart-version.mjs`, the repo's other `import.meta.url`-guarded CLI
 * script) — ts-jest's CommonJS transform doesn't support `import.meta`, so a
 * direct `import` of this module fails with "Cannot use import statement
 * outside a module" regardless of which export is consumed.
 *
 * Two env-var overrides make the run hermetic:
 *   - `AUDIT_JSON_OVERRIDE` — a fixture file replacing the real
 *     `npm audit --omit=dev --json` output.
 *   - `EXEMPT_OVERRIDE` — a fixture file replacing the (currently empty)
 *     real `EXEMPT` list, so exemption scenarios can be tested without
 *     touching production entries.
 *
 * Focus of this file is Rule 4 (the review-date expiry check this test was
 * added for): a future `review` date passes, a past one fails the build.
 * Rules 1-3 (no exemption / stale exemption) get one assertion each so a
 * regression in the pre-existing behaviour doesn't slip through unnoticed.
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
    return { auditReportVersion: 2, metadata: { vulnerabilities: {} }, vulnerabilities };
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
        const result = runScript({
            audit: { auditReportVersion: 2, metadata: { vulnerabilities: {} }, vulnerabilities: {} },
            exempt: [],
        });
        expect(result.code).toBe(0);
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
        const unreachable = result.status === null || out.includes('did not return a report');

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
        expect(out).not.toContain('did not return a report');
    }, 130_000);
});
