/**
 * Query-shape guardrail — the two query-layer ratchets.
 *
 * ─── Why this file exists ───────────────────────────────────────────
 *
 * `schema-index-coverage.test.ts` checks that the SCHEMA carries the
 * right indexes. This file checks that the QUERIES that run against
 * that schema are shaped well — two specific anti-patterns that the
 * index layers cannot catch:
 *
 *   Layer D1 — no Prisma read-query inside a loop (the N+1 pattern).
 *   Layer D2 — unbounded `findMany` budget in repositories.
 *
 * Both are STRUCTURAL scans of `src/app-layer` source — no DB, no
 * runtime, fast. Both are baseline/ratchet tests: today's reality is
 * encoded as a baseline, and the test fails on any FUTURE regression
 * past that baseline.
 *
 * ─── Layer D1 — N+1 detection ───────────────────────────────────────
 *
 * An N+1 query is a read inside a loop: the loop runs N times, each
 * iteration fires its own round-trip to Postgres. The fix is almost
 * always to hoist the read out of the loop — one `findMany` with an
 * `in:` filter, then an in-memory lookup map.
 *
 * The scan finds loop constructs (`for`, `for await`, `while`,
 * `.map`, `.forEach`, `.flatMap`), determines each loop's body span,
 * and looks inside for a Prisma READ call (`findMany`, `findFirst`,
 * `findUnique`, `count`, `aggregate`, `groupBy`, …). WRITE calls
 * (`create` / `update` / `delete`) are deliberately NOT flagged — a
 * write per loop iteration is often unavoidable and is a different
 * concern.
 *
 * Escape hatch: a `// guardrail-allow: n+1` comment on the loop's
 * opening line OR on the matched read line. The current real
 * violations are listed in `KNOWN_N_PLUS_ONE` with a reason each —
 * mostly idempotency checks inside bounded import / seed / batch-job
 * loops, where the per-iteration read is intentional and the loop is
 * over a small bounded set.
 *
 * ─── Layer D2 — unbounded findMany budget ───────────────────────────
 *
 * A repository `findMany` with no `take:` returns the entire result
 * set. For a large tenant that is a latency cliff and a memory risk.
 * Many existing repo methods are legitimately unbounded (small
 * reference tables, internal rollups) — so this is a one-way-down
 * BUDGET, not a hard ban. The current count is locked as
 * `UNBOUNDED_FINDMANY_BUDGET`. A new unbounded `findMany` must
 * either add `take:` or carry a `// guardrail-allow: unbounded`
 * pragma — both keep the count under the ceiling.
 *
 * A second test asserts the budget tracks reality (no drift > 5
 * above the live count), mirroring `formfield-coverage.test.ts` —
 * so a migration that removes unbounded queries cannot leave a
 * stale, slack budget behind.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const APP_LAYER_DIR = path.join(REPO_ROOT, 'src/app-layer');
const REPOSITORIES_DIR = path.join(REPO_ROOT, 'src/app-layer/repositories');

// ─────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────

/** All `.ts` files under a directory, recursively. */
function listTsFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.name.endsWith('.ts')) {
                out.push(full);
            }
        }
    };
    walk(dir);
    return out;
}

/** POSIX-style relative path from repo root (stable across OSes). */
function relPath(abs: string): string {
    return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

/** 1-based line number of a character offset within `text`. */
function lineOf(text: string, offset: number): number {
    return text.slice(0, offset).split('\n').length;
}

/**
 * Balance a bracket/brace pair starting at `openIdx` (which must
 * point at the opening character). Returns the index JUST PAST the
 * matching close, or `text.length` if unbalanced.
 */
function balancedEnd(text: string, openIdx: number, open: string, close: string): number {
    let depth = 0;
    for (let i = openIdx; i < text.length; i++) {
        if (text[i] === open) depth++;
        else if (text[i] === close) {
            depth--;
            if (depth === 0) return i + 1;
        }
    }
    return text.length;
}

// ─────────────────────────────────────────────────────────────────────
// LAYER D1 — N+1 detection.
// ─────────────────────────────────────────────────────────────────────
//
// Each KNOWN_N_PLUS_ONE key is `"relative/path.ts:pattern"`. The
// `pattern` half is the read method + accessor (e.g.
// `findFirst:control`) — stable across small line-number shifts, so
// an unrelated edit above the loop does not churn the baseline.
//
// Every current violation is an INTENTIONAL N+1: an idempotency
// "does this already exist?" check inside a bounded import / seed /
// batch-job loop, a per-framework or per-membership rollup, or a
// snapshot-freeze over a bounded item list. The loops iterate over
// small, bounded collections — not unbounded tenant data — so the
// round-trip count is small and predictable.
//
// Ratchet direction: toward zero. A genuinely hot N+1 should be
// hoisted to a single `findMany({ where: { id: { in: [...] } } })`
// plus an in-memory map. Removing an entry here when the loop is
// fixed keeps the baseline honest.

interface KnownNPlusOne {
    reason: string;
}

const KNOWN_N_PLUS_ONE: Record<string, KnownNPlusOne> = {
    'src/app-layer/jobs/automation-runner.ts:findFirst:integrationExecution': {
        reason:
            'idempotency check inside a scheduled-job loop over due controls — looks up the most recent execution in the current window to avoid double-running. Loop is over the bounded set of automation-enabled controls; hoisting would need a per-control window join.',
    },
    'src/app-layer/jobs/data-lifecycle.ts:findMany:delegate': {
        reason:
            'data-lifecycle sweep iterates a small fixed set of soft-delete-eligible model delegates; each `delegate.findMany` is one query per MODEL, not per row — the loop length is the number of lifecycle-managed models, a compile-time constant.',
    },
    'src/app-layer/jobs/retention-notifications.ts:findFirst:task': {
        reason:
            'idempotency check inside a batch job over expiring evidence — skips creating a duplicate reminder task. Loop is over the bounded "expiring within window" set; the per-item existence check is intentional.',
    },
    'src/app-layer/jobs/retention-notifications.ts:findMany:tenantMembership': {
        reason:
            'retention-notifications batch job — fetches the ADMIN/EDITOR recipients per expiring-evidence row to address the notification. Loop is over the bounded "expiring within window" set; the per-item recipient lookup is a batch-job query, not a request path.',
    },
    // The `findUnique:control` lookup in retention-notifications was
    // removed by the quality-roadmap unused-variable sweep — the
    // resolved `controlName` was never referenced in the
    // notification body. The N+1 baseline entry is now stale.
    'src/app-layer/usecases/evidence-maintenance.ts:findUnique:fileRecord': {
        reason:
            'maintenance scan over file-backed evidence verifying each row\'s FileRecord still exists; an admin/background integrity check, not a hot request path. Loop is over the tenant\'s file evidence — acceptable for a maintenance task.',
    },
    'src/app-layer/usecases/framework/fixtures.ts:findUnique:frameworkRequirement': {
        reason:
            'framework-fixture upsert loop — per-requirement existence check drives create-vs-update. Runs at install / seed time over a fixed framework definition, not on a user request.',
    },
    'src/app-layer/usecases/library-sync.ts:findFirst:framework': {
        reason:
            'library-sync dry-run loop over the loaded library definitions — per-framework lookup classifies would-create / would-update / up-to-date. Admin sync action over a bounded library set.',
    },
    'src/app-layer/usecases/onboarding-automation.ts:findFirst:asset': {
        reason:
            'onboarding-automation seed loop — per-asset idempotency check so re-running onboarding does not duplicate starter assets. Over a fixed starter-asset template list.',
    },
    'src/app-layer/usecases/onboarding-automation.ts:findFirst:task': {
        reason:
            'onboarding-automation seed loop — per-task idempotency check so re-running onboarding does not duplicate starter tasks. Over a fixed starter-task template list.',
    },
    'src/app-layer/usecases/sso.ts:findFirst:tenantIdentityProvider': {
        reason:
            'sign-in SSO-enforcement check — per-membership lookup of an enforced identity provider. Loop is over the user\'s tenant memberships (typically 1-3); the per-membership query is acceptable at sign-in.',
    },
    'src/app-layer/usecases/vendor-audit.ts:findFirst:vendorDocument': {
        reason:
            'audit-pack freeze loop — snapshots each bundle item\'s entity metadata into the frozen item. Per-item lookup is required to read the live entity before freezing; loop is over the bundle\'s items, a bounded set.',
    },
    'src/app-layer/usecases/vendor-audit.ts:findFirst:vendorAssessment': {
        reason:
            'audit-pack freeze loop — snapshots each ASSESSMENT bundle item\'s metadata into the frozen item. Same bounded-items loop as the vendorDocument branch above.',
    },
    'src/app-layer/usecases/webhook-processor.ts:findMany:control': {
        reason:
            'webhook-processor loop over the automation keys triggered by one inbound webhook — per-key lookup of the controls carrying that automation key. Loop is over the triggered-keys list, a small bounded set.',
    },
};

interface NPlusOneFinding {
    key: string;
    file: string;
    loopLine: number;
    readLine: number;
    readMethod: string;
    accessor: string;
    snippet: string;
}

/** Loop constructs we open a body span for. */
const LOOP_RE =
    /\bfor\s+await\s*\(|\bfor\s*\(|\bwhile\s*\(|\.map\s*\(|\.forEach\s*\(|\.flatMap\s*\(/g;

/** A Prisma READ call — write methods are deliberately excluded. */
const PRISMA_READ_RE =
    /\b([A-Za-z_][A-Za-z0-9_]*)\.(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|count|aggregate|groupBy)\s*\(/;
const PRISMA_READ_RE_G = new RegExp(PRISMA_READ_RE.source, 'g');

const N_PLUS_ONE_ALLOW = 'guardrail-allow: n+1';

function scanNPlusOne(): NPlusOneFinding[] {
    const findings: NPlusOneFinding[] = [];
    for (const file of listTsFiles(APP_LAYER_DIR)) {
        const text = fs.readFileSync(file, 'utf8');
        const lines = text.split('\n');
        const rel = relPath(file);

        LOOP_RE.lastIndex = 0;
        let loopMatch: RegExpExecArray | null;
        while ((loopMatch = LOOP_RE.exec(text)) !== null) {
            const token = loopMatch[0];
            const isCallback = /\.(map|forEach|flatMap)\s*\($/.test(token);

            let bodyStart: number;
            let bodyEnd: number;

            if (isCallback) {
                // `.map(` / `.forEach(` / `.flatMap(` — the body is the
                // callback argument; balance the parens of the call.
                const openParen = loopMatch.index + token.length - 1;
                bodyStart = openParen;
                bodyEnd = balancedEnd(text, openParen, '(', ')');
            } else {
                // `for` / `for await` / `while` — skip past the header
                // `(...)`, then balance the `{ ... }` body. A
                // single-statement body (no braces) cannot usefully
                // contain an awaited read, so we skip it.
                const headerOpen = text.indexOf('(', loopMatch.index);
                if (headerOpen === -1) continue;
                const headerEnd = balancedEnd(text, headerOpen, '(', ')');
                let j = headerEnd;
                while (j < text.length && /\s/.test(text[j])) j++;
                if (text[j] !== '{') continue;
                bodyStart = j;
                bodyEnd = balancedEnd(text, j, '{', '}');
            }

            const body = text.slice(bodyStart, bodyEnd);
            const loopLine = lineOf(text, loopMatch.index);
            const loopLineText = lines[loopLine - 1] ?? '';

            // A loop body can contain MORE THAN ONE read — report each
            // distinct (method, accessor) so a multi-read loop is fully
            // covered, not just its first read.
            PRISMA_READ_RE_G.lastIndex = 0;
            let readMatch: RegExpExecArray | null;
            const seenInThisLoop = new Set<string>();
            while ((readMatch = PRISMA_READ_RE_G.exec(body)) !== null) {
                const accessor = readMatch[1];
                const readMethod = readMatch[2];
                const dedupeKey = `${readMethod}:${accessor}`;
                // One finding per (method, accessor) per loop — a loop
                // that reads the same model twice is still one N+1
                // class to triage.
                if (seenInThisLoop.has(dedupeKey)) continue;
                seenInThisLoop.add(dedupeKey);

                const readGlobalOffset = bodyStart + readMatch.index;
                const readLine = lineOf(text, readGlobalOffset);
                const readLineText = lines[readLine - 1] ?? '';

                // Escape hatch on the loop opener OR the read line.
                if (
                    loopLineText.includes(N_PLUS_ONE_ALLOW) ||
                    readLineText.includes(N_PLUS_ONE_ALLOW)
                ) {
                    continue;
                }

                findings.push({
                    key: `${rel}:${readMethod}:${accessor}`,
                    file: rel,
                    loopLine,
                    readLine,
                    readMethod,
                    accessor,
                    snippet: readLineText.trim().slice(0, 90),
                });
            }
        }
    }
    return findings;
}

// ─────────────────────────────────────────────────────────────────────
// LAYER D2 — unbounded findMany budget.
// ─────────────────────────────────────────────────────────────────────
//
// Locked at the live count when this guardrail landed
// (2026-05-21). A one-way-down ceiling: a new unbounded repository
// `findMany` either adds `take:` (bounded) or carries a
// `// guardrail-allow: unbounded` pragma — either way the count
// stays at or below the budget. As repo methods add `take:`, the
// budget drops in lockstep.

// +2 (Feature 1): LocationRepository.list (mirrors the unbounded
// AssetRepository.list) + ParcelRepository.validIdsForLocation (bounded
// in practice by the input id set). Both tenant-scoped.
// Compliance uproot (2026-08-07): compliance uproot removed 7 unbounded findMany call sites.
const UNBOUNDED_FINDMANY_BUDGET = 46;

/** How far the budget may sit ABOVE the live count before it is stale. */
const UNBOUNDED_BUDGET_SLACK = 5;

const UNBOUNDED_ALLOW = 'guardrail-allow: unbounded';

interface UnboundedFinding {
    file: string;
    line: number;
}

function scanUnboundedFindMany(): UnboundedFinding[] {
    const findings: UnboundedFinding[] = [];
    // Repository files only — `src/app-layer/repositories/*.ts`,
    // non-recursive (the directory is flat).
    const files = fs
        .readdirSync(REPOSITORIES_DIR)
        .filter((f) => f.endsWith('.ts'))
        .map((f) => path.join(REPOSITORIES_DIR, f));

    const findManyRe = /\.findMany\s*\(/g;
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        const lines = text.split('\n');
        const rel = relPath(file);

        findManyRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = findManyRe.exec(text)) !== null) {
            const openParen = m.index + m[0].length - 1;
            const argEnd = balancedEnd(text, openParen, '(', ')');
            const arg = text.slice(openParen, argEnd);
            // `take:` anywhere in the balanced argument means bounded.
            if (/\btake\s*:/.test(arg)) continue;

            const line = lineOf(text, m.index);
            const lineText = lines[line - 1] ?? '';
            if (lineText.includes(UNBOUNDED_ALLOW)) continue;

            findings.push({ file: rel, line });
        }
    }
    return findings;
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('query-shape-guardrails — Layer D1: no Prisma read inside a loop (N+1)', () => {
    const findings = scanNPlusOne();

    it('the loop scanner finds the known N+1 sites (scanner sanity)', () => {
        // If the loop/body parser broke, this collapses to ~0 and the
        // ratchet below passes vacuously.
        expect(findings.length).toBeGreaterThan(5);
    });

    it('no NEW Prisma read inside a loop outside the documented baseline', () => {
        const novel = findings.filter((f) => !(f.key in KNOWN_N_PLUS_ONE));
        if (novel.length > 0) {
            const lines = [
                `Found ${novel.length} NEW Prisma read(s) inside a loop ` +
                    `(N+1 risk) not in KNOWN_N_PLUS_ONE:`,
                '',
                ...novel.map(
                    (f) =>
                        `  ${f.file}:${f.readLine}  ` +
                        `[loop opens at :${f.loopLine}]  ` +
                        `${f.accessor}.${f.readMethod}(...)\n` +
                        `      ${f.snippet}`,
                ),
                '',
                'Each is a query that fires once per loop iteration.',
                '',
                'Fix one of:',
                '  1. Hoist the read out of the loop — one findMany with an',
                '     `in:` filter, then build an in-memory lookup map.',
                '  2. If the per-iteration read is genuinely intentional',
                '     (idempotency check in a bounded import/seed loop,',
                '     etc.), add a `// guardrail-allow: n+1` comment on the',
                '     loop opener or the read line, OR add a KNOWN_N_PLUS_ONE',
                '     entry keyed "relative/path.ts:method:accessor" with a',
                '     concise, honest reason.',
            ];
            throw new Error(lines.join('\n'));
        }
        expect(novel.length).toBe(0);
    });

    it('KNOWN_N_PLUS_ONE has no stale entries (every baseline still applies)', () => {
        // A fixed loop whose entry was forgotten quietly weakens the
        // ratchet — flag it so the entry is removed.
        const liveKeys = new Set(findings.map((f) => f.key));
        const stale = Object.keys(KNOWN_N_PLUS_ONE).filter(
            (k) => !liveKeys.has(k),
        );
        if (stale.length > 0) {
            throw new Error(
                `KNOWN_N_PLUS_ONE has ${stale.length} stale entr(y/ies) — ` +
                    `the loop no longer contains the read (fixed or ` +
                    `renamed). Remove:\n` +
                    stale.map((k) => `  ${k}`).join('\n'),
            );
        }
        expect(stale.length).toBe(0);
    });

    it('every KNOWN_N_PLUS_ONE reason is a non-trivial string', () => {
        for (const [key, entry] of Object.entries(KNOWN_N_PLUS_ONE)) {
            expect(typeof entry.reason).toBe('string');
            expect(entry.reason.trim().length).toBeGreaterThan(20);
            // Key shape: "path.ts:method:accessor".
            expect(key.split(':').length).toBeGreaterThanOrEqual(3);
        }
    });
});

describe('query-shape-guardrails — Layer D2: unbounded findMany budget', () => {
    const findings = scanUnboundedFindMany();

    it('the repository scanner finds findMany calls (scanner sanity)', () => {
        expect(findings.length).toBeGreaterThan(10);
    });

    it('unbounded repository findMany count does not exceed the budget', () => {
        if (findings.length > UNBOUNDED_FINDMANY_BUDGET) {
            const novel = findings.slice(UNBOUNDED_FINDMANY_BUDGET);
            const lines = [
                `Found ${findings.length} unbounded repository findMany ` +
                    `call(s) — budget is ${UNBOUNDED_FINDMANY_BUDGET}.`,
                '',
                'An unbounded findMany returns the ENTIRE result set — a',
                'latency + memory cliff for a large tenant.',
                '',
                'Fix the new call one of two ways:',
                '  1. Add a `take:` to the findMany argument (bounded page).',
                '  2. If the result set is genuinely small + bounded (a',
                '     reference table, an internal rollup), append',
                '     `// guardrail-allow: unbounded` to the findMany line',
                '     with a short reason.',
                '',
                'Sample of calls beyond the budget:',
                ...novel
                    .slice(0, 10)
                    .map((f) => `  ${f.file}:${f.line}`),
            ];
            throw new Error(lines.join('\n'));
        }
        expect(findings.length).toBeLessThanOrEqual(UNBOUNDED_FINDMANY_BUDGET);
    });

    it('the budget tracks reality (no slack drift)', () => {
        // If repo methods add `take:`, the count drops — the budget
        // here must drop with them. A drift > UNBOUNDED_BUDGET_SLACK
        // means a previous PR fixed unbounded queries but forgot to
        // lower the budget, leaving slack that hides a future
        // regression. Mirrors `formfield-coverage.test.ts`.
        expect(UNBOUNDED_FINDMANY_BUDGET).toBeLessThanOrEqual(
            findings.length + UNBOUNDED_BUDGET_SLACK,
        );
    });
});
