/**
 * Action-executor coverage ratchet.
 *
 * Locks the invariant that the automation engine ACTUALLY EXECUTES: every
 * AutomationActionType has a handler in the executor, the dispatchers call the
 * executor (not a hardcoded no-op note), and no dispatcher regresses to the
 * "action handlers register in a later epic" stub.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AutomationActionType } from '@prisma/client';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const EXECUTOR = 'src/app-layer/automation/action-executor.ts';
const DISPATCHERS = [
    'src/app-layer/jobs/automation-event-dispatch.ts',
    'src/app-layer/jobs/rule-chain-dispatch.ts',
    'src/app-layer/jobs/subflow-dispatcher.ts',
];

describe('action-executor coverage', () => {
    it('the executor handles every AutomationActionType', () => {
        const src = read(EXECUTOR);
        for (const t of Object.keys(AutomationActionType)) {
            expect(src).toMatch(new RegExp(`case '${t}'`));
        }
    });

    it('every dispatcher calls executeAction', () => {
        for (const d of DISPATCHERS) {
            expect(read(d)).toMatch(/executeAction\(/);
        }
    });

    it('no dispatcher regresses to the no-op stub note', () => {
        for (const d of DISPATCHERS) {
            expect(read(d)).not.toMatch(/action handlers register in a later epic/);
            expect(read(d)).not.toMatch(/no-op: action handlers/);
        }
    });

    it('the executor produces real side effects (not just an execution row)', () => {
        const src = read(EXECUTOR);
        expect(src).toMatch(/notification\.createMany/); // NOTIFY_USER
        expect(src).toMatch(/\.task\.create/); // CREATE_TASK
        expect(src).toMatch(/updateMany/); // UPDATE_STATUS
        expect(src).toMatch(/fetchPublicUrl\(/); // WEBHOOK — per-hop SSRF policy (#3203)
    });
});
