/**
 * VR-5 — visual chain edges ratchet.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
// Comments blanked before matching (#1774). Comments only, NOT strings:
// some assertions below are about string LITERALS, and `{ strings: true }`
// would blank those too and pass vacuously — the trap that makes this
// conversion a per-file decision rather than a sweep.
const read = (p: string) =>
    blankNonCode(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('VR-5 — chain edges', () => {
    it('the edge-kind inference module exists with the 6 automation kinds', () => {
        const p = 'src/lib/processes/edge-kind-inference.ts';
        expect(exists(p)).toBe(true);
        const src = read(p);
        for (const k of [
            'trigger-flow',
            'condition-pass',
            'condition-fail',
            'chain-delay',
            'sla-breach',
            'sla-pass',
        ]) {
            expect(src).toMatch(new RegExp(k));
        }
        expect(src).toMatch(/export function inferEdgeKind/);
    });

    it('ProcessEdge renders a per-kind automation style + chip', () => {
        const src = read('src/components/processes/ProcessEdge.tsx');
        expect(src).toMatch(/AUTOMATION_EDGE_STYLE/);
        expect(src).toMatch(/data-edge-kind-chip/);
    });
});
