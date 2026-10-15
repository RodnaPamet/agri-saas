/**
 * VR-6 — live execution overlay ratchet.
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

describe('VR-6 — execution overlay', () => {
    it('run-mode context + overlay module exist', () => {
        expect(exists('src/lib/processes/run-mode-context.tsx')).toBe(true);
        expect(exists('src/lib/processes/canvas-execution-overlay.tsx')).toBe(true);
    });

    it('the overlay is distributed via context (no per-node tenant SWR)', () => {
        const src = read('src/lib/processes/canvas-execution-overlay.tsx');
        expect(src).toMatch(/CanvasOverlayProvider/);
        expect(src).toMatch(/useNodeOverlayStatus/);
        expect(src).toMatch(/refreshInterval/);
    });

    it('ProcessTypedNode paints the overlay from context (not a tenant hook)', () => {
        const src = read('src/components/processes/ProcessTypedNode.tsx');
        expect(src).toMatch(/useNodeOverlayStatus/);
        expect(src).toMatch(/overlayClass/);
        // must NOT call the tenant SWR poll per node
        expect(src).not.toMatch(/useCanvasExecutionOverlay/);
    });
});
