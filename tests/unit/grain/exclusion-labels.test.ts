/**
 * Excluded records must be recognisable, and never blank.
 *
 * The accordion rendered raw cuids in a monospace list — open "3 plantings
 * missing a yield estimate" and you got `cmslvwqsj0000j44se0pwtxns` three
 * times. The count was honest; the detail was unusable, which made the
 * accordion decoration.
 *
 * The fallback is the part worth testing hardest. A record can be deleted
 * between the read and the label, or a relation can be missing, and a
 * bullet with nothing in it is worse than a bullet with a cuid — the
 * reader cannot even tell how many records are involved.
 */
import { buildExclusionLabels } from '@/lib/grain/exclusion-labels';

const sources = {
    plantings: [
        {
            id: 'p-1',
            parcel: { name: 'Нива 3' },
            cropPlan: { cropType: { name: 'Пшеница' } },
        },
        { id: 'p-orphan', parcel: null, cropPlan: null },
    ],
    lots: [
        { id: 'lot-1', item: { name: 'Пшеница, реколта 2026' } },
        { id: 'lot-orphan', item: null },
    ],
    units: new Map<string, string>([['u-1', 'bag']]),
    leases: [
        { id: 'l-1', lessorName: 'Иван Петров', parcel: { name: 'Нива 7' } },
        { id: 'l-partial', lessorName: 'Мария Георгиева', parcel: null },
        { id: 'l-orphan', lessorName: null, parcel: null },
    ],
    costEntries: [
        {
            id: 'c-1',
            supplier: 'Агро ООД',
            description: 'сезонни работници',
            incurredOn: new Date('2026-07-14T00:00:00Z'),
        },
        { id: 'c-desc', supplier: null, description: 'дневни надници', incurredOn: null },
        { id: 'c-orphan', supplier: null, description: null, incurredOn: null },
    ],
};

describe('buildExclusionLabels', () => {
    const labels = buildExclusionLabels(sources);

    it('names a planting by its parcel and crop', () => {
        expect(labels.planting('p-1')).toBe('Нива 3 · Пшеница');
    });

    it('names a lot by its item, and says WHICH unit failed', () => {
        // The class is "lots whose unit is not a weight" — which unit is
        // the actionable half.
        expect(labels.lot('lot-1', 'bag')).toBe('Пшеница, реколта 2026 (bag)');
        expect(labels.lot('lot-1')).toBe('Пшеница, реколта 2026');
    });

    it('names a lease by its lessor and parcel', () => {
        expect(labels.lease('l-1')).toBe('Иван Петров · Нива 7');
    });

    it('names a cost entry by supplier and date', () => {
        expect(labels.costEntry('c-1')).toBe('Агро ООД · 2026-07-14');
    });

    it('falls back to the description when there is no supplier', () => {
        expect(labels.costEntry('c-desc')).toBe('дневни надници');
    });

    it('skips absent parts rather than printing a dangling separator', () => {
        // "Мария Георгиева · " with nothing after it reads as a bug.
        expect(labels.lease('l-partial')).toBe('Мария Георгиева');
    });

    describe('the fallback — never blank', () => {
        it('uses the id when a planting resolves to nothing', () => {
            expect(labels.planting('p-orphan')).toBe('p-orphan');
        });

        it('uses the id when a lot resolves to nothing', () => {
            expect(labels.lot('lot-orphan')).toBe('lot-orphan');
        });

        it('uses the id when a lease resolves to nothing', () => {
            expect(labels.lease('l-orphan')).toBe('l-orphan');
        });

        it('uses the id when a cost entry resolves to nothing', () => {
            expect(labels.costEntry('c-orphan')).toBe('c-orphan');
        });

        it('uses the id for a record that was not fetched at all', () => {
            // Deleted between the read and the label, or beyond a TAKE cap.
            expect(labels.planting('never-seen')).toBe('never-seen');
            expect(labels.lease('never-seen')).toBe('never-seen');
        });

        it('still appends the unit to an unresolved lot', () => {
            // The id is useless to a person, but the unit is not — it is
            // the thing they would go and change.
            expect(labels.lot('lot-orphan', 'bag')).toBe('lot-orphan (bag)');
        });
    });
});
