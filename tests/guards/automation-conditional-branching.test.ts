/**
 * PR-F — conditional branching ratchet.
 *
 * Keeps the canvas condition-pass/fail edges executable: the schema carries the
 * else branch, the chain dispatcher evaluates the filter and forks, and the
 * canvas sync materializes condition edges into next/else rule ids.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
// Comments blanked before matching (#1774). Comments only, NOT strings:
// an assertion about a string LITERAL would pass vacuously under
// `{ strings: true }`, which is why this stays a per-file decision.
const read = (p: string) =>
    blankNonCode(fs.readFileSync(path.join(ROOT, p), 'utf8'));

describe('conditional branching', () => {
    it('the schema has the elseRuleId branch + relation', () => {
        const src = read('prisma/schema/automation.prisma');
        expect(src).toMatch(/elseRuleId\s+String\?/);
        expect(src).toMatch(/RuleElseChain/);
    });

    it('the chain dispatcher evaluates the filter and forks pass/else', () => {
        const src = read('src/app-layer/jobs/rule-chain-dispatch.ts');
        expect(src).toMatch(/matchesFilter\(/);
        expect(src).toMatch(/rule\.elseRuleId/);
        expect(src).toMatch(/branch: matched \? 'pass' : 'else'/);
        // skip the action on the else branch
        expect(src).toMatch(/'SKIPPED'/);
    });

    it('the canvas sync materializes condition edges into next/else', () => {
        const src = read('src/app-layer/services/canvas-rule-sync.ts');
        expect(src).toMatch(/condition-pass/);
        expect(src).toMatch(/condition-fail/);
        expect(src).toMatch(/elseRuleId: targetRuleId/);
    });
});
