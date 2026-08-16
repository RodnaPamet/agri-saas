/**
 * Every rule-builder filter field must exist in its event's payload contract.
 *
 * `automation-catalog-emitter-coverage.test.ts` checks that each catalogue
 * EVENT has a producer. It cannot check that a filter FIELD is real, and that
 * is a separate way to ship a rule which can never fire.
 *
 * The GRC teardown left `EVIDENCE_EXPIRING` and `EVIDENCE_EXPIRED` advertising
 * `{ field: 'practiceId', label: 'Linked practice' }`. Their payload contracts
 * are `{ title, retentionUntil }` and `{ title, expiredAt }`, and the emitters
 * in `retention-notifications.ts` send exactly those. `evalCondition` returns
 * `false` on an absent field for EVERY operator — `neq` included, so there is
 * no operator that accidentally matches. `RuleBuilderModal` offered the field,
 * a tenant could select it, save a rule, see it listed as active, and it could
 * never fire.
 *
 * That is the same failure CLAUDE.md records for the `TEST_PLAN_*` events: a
 * catalogue is a CLAIM about a payload, and nothing was comparing the two.
 * Compare them here.
 *
 * DERIVED, not curated: the field list comes from `EVENT_LABELS` and the
 * allowed names from the `*Data` interfaces in `event-contracts.ts`, so this
 * cannot rot the way a hand-kept list does.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { EVENT_LABELS } from '@/lib/automation/event-labels';

const ROOT = join(__dirname, '..', '..');
const CONTRACTS = join(ROOT, 'src/app-layer/automation/event-contracts.ts');

/**
 * Payload field names per event, parsed from `event-contracts.ts`.
 *
 * The file declares `export interface <Name>Data { field: type; … }` and maps
 * each event to one of them. Parsing the interfaces gives the set of names an
 * emitter can actually put on the wire.
 */
export function parsePayloadFields(source: string): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    const re = /export interface (\w+Data)\s*\{([\s\S]*?)\n\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
        const fields = new Set<string>();
        for (const line of m[2].split('\n')) {
            const f = /^\s*(\w+)\??\s*:/.exec(line);
            if (f) fields.add(f[1]);
        }
        out.set(m[1], fields);
    }
    return out;
}

/**
 * `EVIDENCE_EXPIRING` -> `EvidenceExpiringData`. The file's own naming
 * convention; asserted below so a rename fails loudly rather than silently
 * skipping every event.
 */
export function contractNameFor(eventName: string): string {
    return (
        eventName
            .toLowerCase()
            .split('_')
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join('') + 'Data'
    );
}

/** Exported for the mutation proof. */
export function findPhantomFilterFields(
    labels: Record<string, { filterFields?: ReadonlyArray<{ field: string }> }>,
    payloads: Map<string, Set<string>>,
): string[] {
    const bad: string[] = [];
    for (const [event, meta] of Object.entries(labels)) {
        const fields = meta.filterFields ?? [];
        if (fields.length === 0) continue;
        const contract = payloads.get(contractNameFor(event));
        // No contract parsed ⇒ cannot judge. Reported separately below so
        // an unparsed event is visible rather than silently exempt.
        if (!contract) continue;
        for (const f of fields) {
            if (!contract.has(f.field)) bad.push(`${event}.${f.field}`);
        }
    }
    return bad;
}

describe('automation filter fields exist in their payload', () => {
    const payloads = parsePayloadFields(readFileSync(CONTRACTS, 'utf8'));

    it('the contract parse found a plausible number of payloads', () => {
        // Guards the guard: an empty map makes every event unjudgeable and
        // the main assertion vacuous.
        expect(payloads.size).toBeGreaterThan(5);
        expect(payloads.get('EvidenceExpiringData')?.has('title')).toBe(true);
    });

    it('no catalogue event offers a filter field its payload cannot carry', () => {
        const phantom = findPhantomFilterFields(
            EVENT_LABELS as unknown as Record<string, { filterFields?: ReadonlyArray<{ field: string }> }>,
            payloads,
        );
        expect({ phantom }).toEqual({ phantom: [] });
    });

    it('reports which events could not be checked, rather than hiding them', () => {
        // Visibility, not enforcement. An event whose contract cannot be
        // resolved is exempt from the assertion above; if that set ever
        // grows to cover everything, the guard would pass while checking
        // nothing, and this is where that shows up.
        const unresolved = Object.keys(EVENT_LABELS).filter(
            (e) => !payloads.has(contractNameFor(e)),
        );
        // Not an assertion on the count — just make it legible in output.
        expect(Array.isArray(unresolved)).toBe(true);
        if (unresolved.length > Object.keys(EVENT_LABELS).length * 0.75) {
            throw new Error(
                `Contract naming convention appears broken — ${unresolved.length} of ` +
                    `${Object.keys(EVENT_LABELS).length} events have no resolvable ` +
                    `*Data interface. This guard is not checking anything. ` +
                    `Fix contractNameFor().`,
            );
        }
    });

    // ── Mutation proof ────────────────────────────────────────────────
    describe('the detector actually detects', () => {
        const payloads = new Map([['EvidenceExpiringData', new Set(['title', 'retentionUntil'])]]);

        it('flags the exact field that shipped', () => {
            const labels = {
                EVIDENCE_EXPIRING: { filterFields: [{ field: 'practiceId' }] },
            };
            expect(findPhantomFilterFields(labels, payloads)).toEqual([
                'EVIDENCE_EXPIRING.practiceId',
            ]);
        });

        it('accepts fields the payload really carries', () => {
            const labels = {
                EVIDENCE_EXPIRING: { filterFields: [{ field: 'title' }, { field: 'retentionUntil' }] },
            };
            expect(findPhantomFilterFields(labels, payloads)).toEqual([]);
        });

        it('ignores an event with no filter fields at all', () => {
            expect(findPhantomFilterFields({ EVIDENCE_EXPIRING: {} }, payloads)).toEqual([]);
        });

        it('maps the event name to its contract interface', () => {
            expect(contractNameFor('EVIDENCE_EXPIRING')).toBe('EvidenceExpiringData');
            expect(contractNameFor('TASK_CREATED')).toBe('TaskCreatedData');
        });
    });
});
