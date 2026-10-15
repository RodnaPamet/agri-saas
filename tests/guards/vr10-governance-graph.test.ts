/**
 * VR-10 — governance graph ratchet.
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

describe('VR-10 — governance graph', () => {
    it('the builder + route + page exist', () => {
        expect(exists('src/app-layer/services/governance-graph-builder.ts')).toBe(true);
        expect(
            exists('src/app/api/t/[tenantSlug]/processes/governance-graph/route.ts'),
        ).toBe(true);
        expect(
            exists('src/app/t/[tenantSlug]/(app)/processes/governance/page.tsx'),
        ).toBe(true);
    });

    it('the builder derives nodes/edges + health from posture', () => {
        const src = read('src/app-layer/services/governance-graph-builder.ts');
        expect(src).toMatch(/export function buildGovernanceGraph/);
        expect(src).toMatch(/export function healthFor/);
        // sub-flow links come from subFlowGroupId
        expect(src).toMatch(/subFlowGroupId/);
        expect(src).toMatch(/'subflow-call'/);
    });
});
