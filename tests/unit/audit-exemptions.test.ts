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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    return { vulnerabilities };
}

/** One blocking-severity advisory, shaped like a real `npm audit --json` entry. */
function advisory(ghsaId: string, severity = 'moderate'): AuditVuln {
    return { severity, via: [{ url: `https://github.com/advisories/${ghsaId}` }] };
}

function runScript(opts: {
    audit: ReturnType<typeof auditReport>;
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

    // ─── End-to-end against the real (currently empty) EXEMPT list ────

    it('the real script, unmodified, exits 0 against the live npm audit gate', () => {
        // No overrides — this is exactly what CI runs (VERIFY step 4). A
        // slow/network-dependent call, so keep it to one confirming case
        // rather than folding every scenario above through it.
        const result = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 60_000 });
        if (result.status !== 0) {
            // Surface the reason so a CI failure here pinpoints the real
            // advisory or expired exemption, not just "exit 1".
            console.error(result.stdout, result.stderr);
        }
        expect(result.status).toBe(0);
    }, 60_000);
});
