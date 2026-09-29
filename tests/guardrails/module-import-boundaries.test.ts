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

/**
 * Read one repo-relative source. A seam, not indirection for its own sake:
 * the CORE side of this seam is empty today (see the 28 / 0 / 291 test
 * below), so `scan()` over the real tree returns `[]` and a gutted `scan`
 * is indistinguishable from a working one BY ITS RESULT. `selector-teeth`
 * confirmed that — gutting `scan` to `[]` survived every assertion in this
 * file (#971). Injecting the reader lets a control feed the scan a
 * population that DOES cross the seam, with no fixture files on disk.
 */
type SourceReader = (relPath: string) => string;

const readFromDisk: SourceReader = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function scan(
    files: readonly string[] = listAppLayerFiles(),
    readSource: SourceReader = readFromDisk,
): Violation[] {
    const violations: Violation[] = [];
    const importRe = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const file of files) {
        const fromDomain = classify(file);
        if (fromDomain === 'platform') continue; // platform may import anything
        const content = readSource(file);
        let m: RegExpExecArray | null;
        importRe.lastIndex = 0; // /g state is shared across files in this loop
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

    // ── Controls (#971) ──────────────────────────────────────────────
    //
    // The classifier self-test below is good and proves `classify` is wired.
    // Nothing proved the SCAN reads anything: `selector-teeth` found `scan`,
    // `listAppLayerFiles`, `resolveImport` and `baselineKey` all survive
    // being gutted.
    //
    // Note `listAppLayerFiles` already routes through `collectTrackedFiles`
    // with `floor: 200`, which throws on an empty selection — and it
    // survived anyway, because gutting replaces the WRAPPER and the floor one
    // layer down never runs. A floor inside a helper cannot protect a caller
    // that stops calling it.
    //
    // The controls below prove the traversal is real — a genuine population
    // with imports the scanner's regex can actually see — and the one after
    // them proves the scan DETECTS a crossing, which no assertion over the
    // real tree can show while the core side of the seam is empty.

    it('control: the scanned population is real and spans the seam', () => {
        const files = listAppLayerFiles();
        expect(files.length).toBeGreaterThan(200);
        expect(files.every((f) => f.startsWith('src/app-layer/') && f.endsWith('.ts'))).toBe(true);

        // The agri side of the seam exists.
        const domains = new Set(files.map((f) => classify(f)));
        expect(domains.has('agri')).toBe(true);

        // ...and the sources carry imports the scanner's own regex matches,
        // so "no violations" means "looked and found none".
        const sample = files
            .slice(0, 40)
            .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
            .join('\n');
        expect(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/.test(sample)).toBe(true);
    });

    it('control: scan DETECTS a cross-seam import, and only the cross-seam one', () => {
        // The assertions at the top of this file cannot show this. The core
        // side of the seam is empty (28 agri / 0 core / 291 platform — see
        // the test below), so `scan()` over the real tree returns `[]`, and
        // `[]` is what a gutted scan returns too. `selector-teeth` measured
        // exactly that: gutting `scan` survived this whole file (#971).
        //
        // So drive it over a SYNTHETIC population that does cross the seam.
        // No fixture files are needed: a file's domain comes from its PATH,
        // and its imports come from the injected reader.
        const agri = 'src/app-layer/usecases/journal-synthetic.ts';
        const core = 'src/app-layer/usecases/vendor-synthetic.ts';
        const sources: Record<string, string> = {
            // Three imports from the agri side, and only ONE of them crosses:
            //   • a platform import — legal, agri may depend on platform
            //   • the core import   — the violation this ratchet exists for
            //   • a bare specifier  — must resolve to null, not to a repo path
            [agri]:
                "import { a } from '@/app-layer/auth/session';\n" +
                "import { x } from '@/app-layer/usecases/vendor-synthetic';\n" +
                "import React from 'react';\n",
            [core]: "export const y = 1;\n",
        };
        const found = scan([agri, core], (rel) => sources[rel] ?? '');

        // Exactly one — a scan that flagged everything would satisfy a bare
        // "found something" assertion just as well as a working one.
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({
            from: agri,
            fromDomain: 'agri',
            to: 'src/app-layer/usecases/vendor-synthetic',
            toDomain: 'core',
            spec: '@/app-layer/usecases/vendor-synthetic',
        });
    });

    it('control: a crossing found by scan is one the ratchet would FAIL on', () => {
        // The scan finding a violation is only half of it — the assertion at
        // the top filters by BASELINE, so a detected crossing still has to
        // survive that filter to redden CI. This runs the same predicate the
        // real assertion uses over the synthetic finding.
        const agri = 'src/app-layer/usecases/grain-synthetic.ts';
        const core = 'src/app-layer/usecases/compliance-synthetic.ts';
        const found = scan(
            [agri, core],
            (rel) =>
                rel === agri
                    ? "import { z } from '@/app-layer/usecases/compliance-synthetic';\n"
                    : '',
        );
        const baselineKeys = new Set(BASELINE.map((b) => baselineKey(b.from, b.to)));
        const unexpected = found.filter((v) => !baselineKeys.has(baselineKey(v.from, v.to)));
        expect(unexpected).toHaveLength(1);
    });

    it('the CORE side of the seam is currently empty — this ratchet has nothing to cross', () => {
        // Measured while adding the controls above, and it changes how this
        // file's green should be read. `classify` sorts app-layer into
        // agri / core / platform, and today that is 28 / 0 / 291.
        //
        // CORE_RE matches compliance, vendor and the audit-CYCLE domain. The
        // GRC teardown deleted all of it, so there is no core file left for
        // an agri file to import. This ratchet therefore reports "no NEW
        // agri⇄core imports" because one side of the boundary does not
        // exist — not because the boundary is being respected. Its four dead
        // selectors were never the only reason it could not fail.
        //
        // Pinned at 0 deliberately, so this test FAILS the moment a core
        // file returns. That failure is the signal that the ratchet has
        // become live work again: delete this test then, and the guard above
        // starts doing what it was written to do.
        const core = listAppLayerFiles().filter((f) => classify(f) === 'core');
        expect(core).toEqual([]);
    });

    it('control: resolveImport maps the specifier shapes the scan depends on', () => {
        expect(resolveImport('@/lib/x', 'src/app-layer/usecases/a.ts')).toBe('src/lib/x');
        expect(resolveImport('./b', 'src/app-layer/usecases/a.ts')).toBe('src/app-layer/usecases/b');
        // Bare specifiers must stay null: returning '' instead would make
        // every node_modules import look like a repo path to classify.
        expect(resolveImport('react', 'src/app-layer/usecases/a.ts')).toBeNull();
    });

    it('control: baselineKey distinguishes different edges', () => {
        // BASELINE is empty today, so a collapsed key changes nothing YET.
        // The moment an entry is added, a constant key would mark every
        // violation as baselined and suppress the whole ratchet.
        expect(baselineKey('a', 'b')).toBe(baselineKey('a', 'b'));
        expect(baselineKey('a', 'b')).not.toBe(baselineKey('a', 'c'));
        expect(baselineKey('a', 'b')).not.toBe(baselineKey('c', 'b'));
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
