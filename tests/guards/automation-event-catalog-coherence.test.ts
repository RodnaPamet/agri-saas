/**
 * Automation event-catalog coherence ratchet.
 *
 * Every event NAME that any code actually emits via `emitAutomationEvent`
 * MUST be a subscribable catalog entry (`AUTOMATION_EVENT_NAMES`) — otherwise a
 * rule can never be built to trigger on it (producer/catalog drift). This is
 * the guard the evidence-expiry gap motivated.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AUTOMATION_EVENT_NAMES } from '@/app-layer/automation/events';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

function walk(dir: string, acc: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, acc);
        else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) acc.push(full);
    }
    return acc;
}

describe('automation event catalog coherence', () => {
    // Collect every `event: 'NAME'` literal that sits in a file which calls
    // emitAutomationEvent — the producer surface.
    // The event catalog / contract / label files DEFINE the union (every name
    // appears as `event: 'NAME'`) — they are not producers, so exclude them;
    // we only want real `emitAutomationEvent(...)` call sites.
    const DEFINITION_FILES = ['event-contracts.ts', 'event-labels.ts', 'automation/events.ts'];
    const emitted = new Set<string>();
    for (const f of walk(SRC)) {
        if (DEFINITION_FILES.some((d) => f.endsWith(d) || f.includes(d))) continue;
        const src = blankNonCode(fs.readFileSync(f, 'utf8'));
        if (!src.includes('emitAutomationEvent')) continue;
        for (const m of src.matchAll(/event:\s*'([A-Z_]+)'/g)) emitted.add(m[1]);
    }

    it('found producer event names to check', () => {
        expect(emitted.size).toBeGreaterThan(0);
    });

    it('every emitted event name is in the subscribable catalog', () => {
        const catalog = new Set<string>(AUTOMATION_EVENT_NAMES as readonly string[]);
        const orphans = [...emitted].filter((e) => !catalog.has(e));
        expect(orphans).toEqual([]);
    });

    it('the evidence-expiry trigger events are in the catalog', () => {
        expect(AUTOMATION_EVENT_NAMES).toContain('EVIDENCE_EXPIRING');
        expect(AUTOMATION_EVENT_NAMES).toContain('EVIDENCE_EXPIRED');
    });
});
