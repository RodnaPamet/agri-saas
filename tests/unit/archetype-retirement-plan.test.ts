/**
 * What retiring the sample products decides, tested without a database.
 *
 * `scripts/retire-sample-products.ts` is a shell: read, print, write. Every
 * decision is in `planArchetypeRetirement`, so this is where the script is
 * verified — the split `tests/unit/backfill-token-encryption.test.ts` uses.
 *
 * Two of these cases exist because the failure is silent and expensive:
 *
 *   · **retiring a real product.** A farm's own catalogue entry would vanish
 *     from every picker with nothing to say why, and the farmer cannot tell a
 *     retired item from a deleted one. `isArchetype` is the only signal used,
 *     and that is deliberate: #1078 judged the three inferable signals (name
 *     `Generic %`, null `createdByUserId`, present `attributesJson`)
 *     insufficient to justify a REFUSAL, and they are no better for a write.
 *   · **re-stamping an already-retired row.** Re-running would move
 *     `deletedAt` forward every time, destroying the record of when the
 *     retirement actually happened — and nothing would fail.
 */
import {
    planArchetypeRetirement,
    type ArchetypeCandidate,
} from '@/lib/catalog/archetype-retirement-plan';

function item(over: Partial<ArchetypeCandidate> & { id: string }): ArchetypeCandidate {
    return {
        name: `Generic ${over.id}`,
        category: 'PESTICIDE',
        isArchetype: true,
        deletedAt: null,
        operationLines: 0,
        lots: 0,
        costEntries: 0,
        ...over,
    };
}

describe('the archetype retirement plan', () => {
    it('retires an unreferenced archetype', () => {
        const plan = planArchetypeRetirement([item({ id: 'a' })]);

        expect(plan.retire.map((r) => r.id)).toEqual(['a']);
        expect(plan).toMatchObject({ archetypesSeen: 1, unreferenced: 1, referenced: 0 });
    });

    it('retires a REFERENCED archetype too, and counts it as referenced', () => {
        // The owner's ruling, and it rests on a measurement: a past record
        // reads its product as a relation include with no `deletedAt`, so the
        // ДНЕВНИК keeps rendering the name after the soft delete. "Keep the
        // ones past records already use" is satisfied by the row surviving,
        // not by exempting it from retirement.
        const plan = planArchetypeRetirement([item({ id: 'a', operationLines: 3 })]);

        expect(plan.retire.map((r) => r.id)).toEqual(['a']);
        expect(plan.referenced).toBe(1);
        expect(plan.retire[0].references).toBe(3);
    });

    it('NEVER retires a real product, and counts the ones it left alone', () => {
        // The expensive mistake. Counted rather than merely skipped, so the
        // script can print "real products UNTOUCHED: N" as a measurement
        // instead of the reader taking it on trust.
        const plan = planArchetypeRetirement([
            item({ id: 'arch' }),
            item({ id: 'real', isArchetype: false, name: 'Карате Зеон 050 CS' }),
            item({ id: 'real2', isArchetype: false, name: 'Амониев нитрат', operationLines: 9 }),
        ]);

        expect(plan.retire.map((r) => r.id)).toEqual(['arch']);
        expect(plan.realProductsUntouched).toBe(2);
        expect(plan.archetypesSeen).toBe(1);
    });

    it('skips an already-retired archetype rather than re-stamping it', () => {
        const plan = planArchetypeRetirement([
            item({ id: 'done', deletedAt: new Date('2026-01-01') }),
            item({ id: 'todo' }),
        ]);

        expect(plan.retire.map((r) => r.id)).toEqual(['todo']);
        expect(plan.alreadyRetired).toBe(1);
        expect(plan.archetypesSeen).toBe(2);
    });

    it('is idempotent: applying the plan leaves nothing for a second run', () => {
        // The claim the script's docblock makes. Worth a test rather than a
        // sentence, because the failure — a retirement date that moves on every
        // run — is invisible until someone asks when it happened.
        const items = [item({ id: 'a' }), item({ id: 'b', lots: 2 })];
        const first = planArchetypeRetirement(items);
        const applied = items.map((i) =>
            first.retire.some((r) => r.id === i.id) ? { ...i, deletedAt: new Date() } : i,
        );

        const second = planArchetypeRetirement(applied);

        expect(first.retire).toHaveLength(2);
        expect(second.retire).toHaveLength(0);
        expect(second.alreadyRetired).toBe(2);
    });

    it('sums references across ALL THREE relations, not just operation lines', () => {
        // An archetype can be referenced by an inventory lot or a cost entry
        // with no operation line at all. Counting only `operationLines` would
        // report it as unreferenced — which does not change whether it is
        // retired, but does misreport the blast radius the owner is deciding
        // from.
        const plan = planArchetypeRetirement([
            item({ id: 'a', operationLines: 1, lots: 2, costEntries: 4 }),
        ]);

        expect(plan.retire[0].references).toBe(7);
        expect(plan.byRelation).toEqual({ operationLines: 1, lots: 2, costEntries: 4 });
    });

    it('counts lots-only and costs-only archetypes as referenced', () => {
        const plan = planArchetypeRetirement([
            item({ id: 'lots', lots: 1 }),
            item({ id: 'costs', costEntries: 1 }),
            item({ id: 'none' }),
        ]);

        expect(plan.referenced).toBe(2);
        expect(plan.unreferenced).toBe(1);
    });

    it('an empty catalogue plans nothing', () => {
        expect(planArchetypeRetirement([])).toMatchObject({
            archetypesSeen: 0,
            alreadyRetired: 0,
            referenced: 0,
            unreferenced: 0,
            realProductsUntouched: 0,
        });
    });

    it('control: a catalogue of ONLY real products retires nothing', () => {
        // The shape of the worst outcome, asserted directly: if the predicate
        // were inverted or dropped, this would retire everything.
        const plan = planArchetypeRetirement([
            item({ id: 'r1', isArchetype: false }),
            item({ id: 'r2', isArchetype: false }),
        ]);

        expect(plan.retire).toEqual([]);
        expect(plan.realProductsUntouched).toBe(2);
    });
});
