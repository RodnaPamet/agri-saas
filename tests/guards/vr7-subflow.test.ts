/**
 * VR-7 — sub-flow nesting ratchet.
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

describe('VR-7 — sub-flow nesting', () => {
    it('schema carries INVOKE_SUBFLOW + subFlowGroupId', () => {
        expect(read('prisma/schema/enums.prisma')).toMatch(/INVOKE_SUBFLOW/);
        expect(read('prisma/schema/automation.prisma')).toMatch(/subFlowGroupId/);
        expect(read('src/app-layer/schemas/automation.schemas.ts')).toMatch(/INVOKE_SUBFLOW/);
    });

    it('the subflow dispatcher job + registration exist', () => {
        expect(exists('src/app-layer/jobs/subflow-dispatcher.ts')).toBe(true);
        const job = read('src/app-layer/jobs/subflow-dispatcher.ts');
        expect(job).toMatch(/parentExecutionId/);
        expect(job).toMatch(/triggeredBy: 'subflow'/);
        // registered + tenant-scoped
        const reg = read('src/app-layer/jobs/executor-registry.ts');
        expect(reg).toMatch(/'subflow-dispatch'/);
        expect(reg).toMatch(/tenantId: payload\.tenantId/);
    });
});
