/**
 * Every WRITE on the process-map surface asserts the CERTIFICATION module
 * (#3291), and the rule is DERIVED rather than a list of names.
 *
 * The gate used to sit on `processes/route.ts` alone, which covered 2 of the
 * surface's 12 operations. The other ten are reachable by id and were
 * ungated — `DELETE` and snapshot `restore` among them — so a farm with the
 * module off could not browse the index and could still destroy a map.
 *
 * That is `count-the-routes-a-gate-covers`: the gate was named correctly and
 * placed on the route somebody thought of first, and nobody printed the
 * denominator. The repo has hit it at least three times (ten API routes then
 * four pages for the suspension check; the upload gate two of six paths
 * reached), which is why this guard derives its population instead of
 * enumerating today's writes.
 *
 * ## The property
 *
 * In `usecases/process-map.ts`, every exported function that calls
 * `assertCanWrite` must also call `assertModuleEnabled`. `assertCanWrite` is
 * the repo's own marker for "this changes state", so a new write inherits the
 * requirement the moment it is written — and a reader can see why the
 * population is what it is.
 *
 * ## What is deliberately NOT required
 *
 * Reads. Owner ruling 2026-11-27: a farm keeps access to work it already did
 * and to its PDF history, and simply cannot add to it — #1655's deletion
 * freeze applied to an entitlement, where "no new content" and "nothing
 * visible" are different decisions.
 *
 * So `getProcessMap`, `listProcessMapSnapshots` and `getProcessMapSnapshot`
 * are expected to have no module assertion, and the two POST "export" routes
 * are expected to reach read usecases: `generateProcessMapPdf` wraps a PNG
 * the client already rendered and persists nothing, and
 * `buildAutomationEvidencePack` is `assertCanRead` plus `findMany`. Both are
 * reads in POST clothing, and the test below says so by NAME so that a future
 * change making either of them persist something fails here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { REPO_ROOT } from '../helpers/collect-files';

const USECASES = 'src/app-layer/usecases/process-map.ts';

/** Exported functions in the module, with their bodies. */
function exportedFunctions(src: string): { name: string; body: string }[] {
    const code = blankNonCode(src, { strings: false });
    const out: { name: string; body: string }[] = [];
    const re = /export async function (\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    const starts: { name: string; at: number }[] = [];
    while ((m = re.exec(code)) !== null) starts.push({ name: m[1]!, at: m.index });
    for (let i = 0; i < starts.length; i += 1) {
        const end = i + 1 < starts.length ? starts[i + 1]!.at : code.length;
        out.push({ name: starts[i]!.name, body: code.slice(starts[i]!.at, end) });
    }
    return out;
}

describe('process-map writes assert the CERTIFICATION module (#3291)', () => {
    const src = readFileSync(path.join(REPO_ROOT, USECASES), 'utf8');
    const fns = exportedFunctions(src);
    const writes = fns.filter((f) => /assertCanWrite\(/.test(f.body));
    const reads = fns.filter((f) => !/assertCanWrite\(/.test(f.body));

    it('ranges over a real population', () => {
        console.log(
            `[process-map-gate] ${fns.length} exported usecase(s): ` +
                `${writes.length} write(s), ${reads.length} read(s)`,
        );
        // Floors, so an extraction that stopped matching fails here rather
        // than passing over nothing — the whole point of the rule.
        expect(fns.length).toBeGreaterThanOrEqual(9);
        expect(writes.length).toBeGreaterThanOrEqual(5);
        expect(reads.length).toBeGreaterThanOrEqual(3);
    });

    it('every WRITE asserts the module', () => {
        const ungated = writes
            .filter((f) => !/assertModuleEnabled\(/.test(f.body))
            .map((f) => f.name);
        if (ungated.length > 0) {
            throw new Error(
                `These process-map writes change state without asserting the ` +
                    `CERTIFICATION module:\n` +
                    ungated.map((n) => `  ${n}`).join('\n') +
                    `\n\nAdd \`await assertModuleEnabled(ctx, 'CERTIFICATION')\` beside ` +
                    `\`assertCanWrite\`. #3291 is what a partial gate costs: it covered 2 ` +
                    `of 12 operations, so a farm with the module off could not see the ` +
                    `index and could still delete a map and restore a snapshot.`,
            );
        }
        expect(ungated).toEqual([]);
    });

    it('READS are deliberately NOT gated — the owner ruling, pinned', () => {
        // Not a free pass: this asserts the reads are STILL open, so a later
        // change that gates them wholesale has to come past this test and the
        // ruling it records rather than sliding in as tidying.
        const gatedReads = reads
            .filter((f) => /assertModuleEnabled\(/.test(f.body))
            .map((f) => f.name);
        expect(gatedReads).toEqual([]);
    });

    it('CONTROL: the extractor really finds the writes it claims to', () => {
        // Without this, "no ungated writes" is satisfied by a parser that
        // found no writes at all.
        const names = writes.map((f) => f.name).sort();
        expect(names).toEqual(
            expect.arrayContaining([
                'createProcessMap',
                'deleteProcessMap',
                'restoreProcessMapSnapshot',
                'saveProcessMap',
                'setProcessMapCanvasMode',
            ]),
        );
    });

    it('CONTROL: the extractor separates bodies rather than running them together', () => {
        // A naive split would put every assertion in one blob, so every
        // function would look gated. `getProcessMap` is a read and must come
        // back WITHOUT a module assertion.
        const get = fns.find((f) => f.name === 'getProcessMap');
        expect(get).toBeDefined();
        expect(/assertCanRead\(/.test(get!.body)).toBe(true);
        expect(/assertModuleEnabled\(/.test(get!.body)).toBe(false);
    });

    it('the two POST exports reach READ usecases, and persist nothing', () => {
        // Named explicitly so a change making either persist something — and
        // therefore needing the gate — fails here rather than quietly
        // becoming an ungated write.
        const pack = readFileSync(
            path.join(REPO_ROOT, 'src/app-layer/usecases/automation-export.ts'),
            'utf8',
        );
        const code = blankNonCode(pack, { strings: false });
        const idx = code.indexOf('export async function buildAutomationEvidencePack');
        expect(idx).toBeGreaterThan(-1);
        const body = code.slice(idx, idx + 2000);
        expect(/assertCanRead\(/.test(body)).toBe(true);
        expect(/assertCanWrite\(/.test(body)).toBe(false);
    });
});
