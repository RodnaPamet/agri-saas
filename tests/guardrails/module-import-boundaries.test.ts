/**
 * Guardrail: agri ⇄ core module-import boundary.
 *
 * The audit's strategic finding: ~53% of the models are inherited compliance
 * machinery, agriculture runs on ~19%, and the seam between them was enforced
 * by NOTHING. This ratchet makes the seam real in CI.
 *
 * Three domains, by path ownership within src/app-layer:
 *   • agri     — journal, planning, grain, exchange, agriculture, agro,
 *                inventory, insurance, promotions
 *   • core     — compliance, vendor, audit(-cycle)
 *   • platform — everything else (auth, automation, permissions, processes,
 *                knowledge, ai, lib, events, jobs, …)
 *
 * Contract: agri and core may BOTH import platform. agri ⇄ core imports are
 * violations. Today's real violations are baselined with a one-line reason;
 * the ratchet is downward-only (a drift sentinel forbids slack accumulation),
 * mirroring `no-explicit-any-ratchet`. Remove a cross-import ⇒ delete its
 * baseline entry in the same PR.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { collectTrackedFiles } from '../helpers/collect-files';

const ROOT = path.resolve(__dirname, '../..');
const APP_LAYER = 'src/app-layer';

type Domain = 'agri' | 'core' | 'platform';

const AGRI_RE = /(?:^|\/)(?:journal|planning|grain|exchange|agriculture|agro|inventory|insurance|promotions?)/i;
// core is deliberately narrow (the audit's "inherited compliance machinery"):
// compliance, vendor, and the audit-CYCLE domain (AuditCycle/Pack/Auditor).
// NOT the bare audit-LOG infra (events/audit.ts, AuditLogRepository,
// audit-stream) — that's a platform concern every domain writes to.
const CORE_RE = /(?:^|\/)(?:compliance|vendor)|audit-cycle|auditcycle|audit-pack|auditor/i;

/** Classify a repo-relative path into a domain by its ownership keyword. */
function classify(rel: string): Domain {
    // Strip the app-layer prefix + the sub-bucket (usecases/repositories/…) so
    // we match on the feature segment, not the folder taxonomy.
    const p = rel.replace(/^src\/app-layer\//, '');
    if (AGRI_RE.test(p)) return 'agri';
    if (CORE_RE.test(p)) return 'core';
    return 'platform';
}

/**
 * Known agri⇄core cross-imports that exist today. Each MUST carry a reason.
 * The list is a downward ratchet — new cross-imports fail; fixing one means
 * deleting its entry here in the same diff.
 */
interface Baselined {
    from: string;
    to: string;
    reason: string;
}
const BASELINE: readonly Baselined[] = [
    // (populated from the first scan — see the test output)
];

function baselineKey(from: string, to: string): string {
    return `${from} -> ${to}`;
}

/**
 * The app-layer sources this ratchet reads, repo-relative — `classify()` and the
 * BASELINE keys are both written in repo-relative form, so the shape is
 * load-bearing and the absolute paths the helper returns are converted back.
 *
 * Collected through `collectTrackedFiles` so an empty result FAILS (#865).
 * `git ls-files <missing-path>` exits 0 with no output, so a renamed
 * `src/app-layer` would have made every assertion below pass over nothing. The
 * floor is set well under the 318 files present today: it has to survive
 * ordinary churn while still catching a selection that collapsed.
 */
function listAppLayerFiles(): string[] {
    return collectTrackedFiles({
        roots: [APP_LAYER],
        extensions: ['.ts'],
        exclude: (rel) => rel.endsWith('.d.ts'),
        floor: 200,
    }).map((abs) => path.relative(ROOT, abs).replace(/\\/g, '/'));
}

/** Resolve an import specifier to a repo-relative path under src/, or null. */
function resolveImport(spec: string, fromFile: string): string | null {
    let target: string;
    if (spec.startsWith('@/')) {
        target = path.join('src', spec.slice(2));
    } else if (spec.startsWith('.')) {
        target = path.normalize(path.join(path.dirname(fromFile), spec));
    } else {
        return null; // node_modules / bare specifier
    }
    return target.replace(/\\/g, '/');
}

interface Violation {
    from: string;
    fromDomain: Domain;
    to: string;
    toDomain: Domain;
    spec: string;
}

function scan(): Violation[] {
    const violations: Violation[] = [];
    const importRe = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const file of listAppLayerFiles()) {
        const fromDomain = classify(file);
        if (fromDomain === 'platform') continue; // platform may import anything
        const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
        let m: RegExpExecArray | null;
        while ((m = importRe.exec(content)) !== null) {
            const spec = m[1] ?? m[2];
            if (!spec) continue;
            const resolved = resolveImport(spec, file);
            if (!resolved || !resolved.startsWith(APP_LAYER)) continue;
            const toDomain = classify(resolved);
            if (toDomain === 'platform') continue;
            if (fromDomain !== toDomain) {
                // agri importing core, or core importing agri.
                violations.push({ from: file, fromDomain, to: resolved, toDomain, spec });
            }
        }
    }
    return violations;
}

describe('module-import-boundaries', () => {
    const violations = scan();
    const baselineKeys = new Set(BASELINE.map((b) => baselineKey(b.from, b.to)));

    it('has no NEW agri ⇄ core imports beyond the documented baseline', () => {
        const unexpected = violations.filter((v) => !baselineKeys.has(baselineKey(v.from, v.to)));
        if (unexpected.length > 0) {
            const report = unexpected
                .map((v) => `  [${v.fromDomain}] ${v.from}\n      → [${v.toDomain}] ${v.to}   (import '${v.spec}')`)
                .join('\n');
            throw new Error(
                `Found ${unexpected.length} NEW agri⇄core import(s) that cross the module seam.\n` +
                `agri and core must only depend on platform, not each other. Route the shared code\n` +
                `through platform, or (if genuinely unavoidable) add a BASELINE entry with a reason:\n${report}`,
            );
        }
        expect(unexpected).toHaveLength(0);
    });

    it('every BASELINE entry still corresponds to a real cross-import (no stale entries)', () => {
        const liveKeys = new Set(violations.map((v) => baselineKey(v.from, v.to)));
        const stale = BASELINE.filter((b) => !liveKeys.has(baselineKey(b.from, b.to)));
        expect(stale.map((s) => baselineKey(s.from, s.to))).toEqual([]);
    });

    it('classifier self-test: the domain rules are wired correctly', () => {
        expect(classify('src/app-layer/usecases/journal.ts')).toBe('agri');
        expect(classify('src/app-layer/usecases/exchange.ts')).toBe('agri');
        expect(classify('src/app-layer/usecases/vendor.ts')).toBe('core');
        expect(classify('src/app-layer/usecases/audit-cycle.ts')).toBe('core');
        expect(classify('src/app-layer/usecases/risk.ts')).toBe('platform'); // narrow core: risk is not core
        expect(classify('src/app-layer/usecases/auth-thing.ts')).toBe('platform');
    });
});
