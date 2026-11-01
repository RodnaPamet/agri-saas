import { readCatalogue, locales } from '../helpers/catalogue';
import { ENUM_LABEL_NAMESPACES, type EnumKind } from '@/lib/assistant/enum-labels';

/**
 * Every member of every enum the assistant can emit HAS a label, in every
 * locale.
 *
 * The population is DERIVED from `@prisma/client` rather than listed, which is
 * the whole point: adding a `LogEntryType` member fails this guard until it is
 * named, instead of leaking «(TRANSPLANTING)» into a farmer's answer months
 * later. A list someone has to remember to update is the failure mode, not the
 * check.
 *
 * That is exactly how this shipped: the labels already existed and were already
 * on screen in the web app. Nothing was missing except the resolution — and
 * nothing compared the two.
 */

/** Members of one enum that have no label in a given locale. Module-level for selector-teeth. */
export function missingLabels(kind: EnumKind, catalogue: Record<string, unknown>): string[] {
    const { values, ns } = ENUM_LABEL_NAMESPACES[kind];
    const bucket = ns.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], catalogue);
    const labels = (bucket ?? {}) as Record<string, unknown>;
    return Object.values(values).filter((v) => typeof labels[v as string] !== 'string') as string[];
}

describe('assistant enum labels are complete (#2680 follow-up)', () => {
    const kinds = Object.keys(ENUM_LABEL_NAMESPACES) as EnumKind[];

    it('the population is derived from Prisma and is not empty', () => {
        const total = kinds.reduce(
            (n, k) => n + Object.values(ENUM_LABEL_NAMESPACES[k].values).length,
            0,
        );
        console.log(`[assistant-enum-labels] ${kinds.length} enum(s), ${total} member(s), ${locales().length} locale(s)`);
        // Floors: an empty kind list or an empty enum would satisfy every
        // assertion below over nothing at all.
        expect(kinds.length).toBeGreaterThanOrEqual(5);
        expect(total).toBeGreaterThanOrEqual(30);
        expect(locales().length).toBeGreaterThanOrEqual(2);
    });

    it.each(locales())('%s: every enum member has a label', (locale) => {
        const catalogue = readCatalogue(locale) as unknown as Record<string, unknown>;
        const gaps = kinds.flatMap((k) => missingLabels(k, catalogue).map((v) => `${k}.${v}`));
        expect(gaps).toEqual([]);
    });

    it('the detector can SELECT — the control', () => {
        // `toEqual([])` above is satisfied perfectly by a detector that never
        // finds anything. So it is shown to report a REAL gap, produced by
        // removing one label from the REAL catalogue rather than a synthetic
        // one — a control fed its own data keeps passing with the reader gutted.
        const real = JSON.parse(JSON.stringify(readCatalogue('bg'))) as Record<string, unknown>;
        const journal = (real.journalEnums as Record<string, Record<string, string>>).logType;
        const victim = Object.keys(journal)[0] as string;
        delete journal[victim];

        const gaps = missingLabels('logType', real);
        expect(gaps).toContain(victim);
        // ...and it is specific: removing one label reports one gap, not all.
        expect(gaps).toHaveLength(1);
    });
});
