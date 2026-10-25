/**
 * Guard: every `FieldOperationType` value reaches the four places that
 * enumerate it, and the one list that is deliberately narrower says so (#2316).
 *
 * ## What was unchecked
 *
 * `FieldOperationType` had four values and at least five hand-written lists
 * restating them — a localisation membership map, two message catalogues, an
 * automation filter's options, and a zod accept-list — with **nothing comparing
 * any of them to the enum**. That is fine until a value is added, which #2316
 * does three times.
 *
 * Each omission fails differently, and none of them fails loudly:
 *
 *   - missing from `FIELD_OPERATION_TYPES` → the journal's Operation column
 *     prints the raw value, so a farmer reads `PRUNE`;
 *   - missing from `journalEnums.operationType` in either locale → next-intl
 *     renders the key path;
 *   - missing from the automation filter's options → a rule cannot filter on a
 *     kind that exists in the data, and the UI offers no hint that it exists;
 *   - missing from `ACTIVITY_LABELS_BG` → an empty «Мероприятие» cell in a
 *     regulated document. (That one is additionally a `tsc` error, because the
 *     map is typed `Record<FieldOperationType, string>`. It is asserted here
 *     too so the failure names this relationship rather than a type position.)
 *
 * ## The one list that is NOT equal, on purpose
 *
 *     CreateFieldOperationSchema.operationType  ⊂  FieldOperationType
 *
 * That schema creates an operation which APPLIES AN INPUT: its `superRefine`
 * requires exactly one of product/fertiliser and refuses neither. A bare
 * activity has neither by definition, so accepting the value there would admit
 * a payload the same schema then rejects — the caller would get a 400 about a
 * missing product on a pruning job. Every member of the difference is listed
 * below with why. A value added tomorrow lands in neither list and fails here,
 * which forces "can this be created by that route?" to be answered rather than
 * inherited.
 */
import { FieldOperationType } from '@prisma/client';

import { ACTIVITY_LABELS_BG, BARE_ACTIVITY_KINDS } from '@/lib/operations/activity-labels';
import { FIELD_OPERATION_TYPES } from '@/app/t/[tenantSlug]/(app)/journal/filter-defs';
import { EVENT_LABELS } from '@/lib/automation/event-labels';
import { AUTOMATION_EVENTS } from '@/app-layer/automation/events';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readCatalogue } from '../helpers/catalogue';

const ALL = Object.keys(FieldOperationType) as FieldOperationType[];
const ROOT = path.resolve(__dirname, '../..');

/**
 * Values `CreateFieldOperationSchema` must NOT accept, each with why.
 *
 * An entry is a kind that carries no product or dose, so the XOR that schema
 * enforces cannot be satisfied for it.
 */
const INPUT_LESS: Readonly<Record<string, string>> = {
    PRUNE: 'Резитба applies nothing — there is no product and no dose to satisfy the product/fertiliser XOR.',
    CULTIVATE: 'Обработка на почвата applies nothing; the same XOR refusal.',
    HARVEST: 'Прибиране removes produce rather than applying an input, and its quantity is a YieldRecord in tonnes, not a dose.',
};

describe('FieldOperationType mirrors (#2316)', () => {
    it('the enum itself is non-trivial, so the comparisons below mean something', () => {
        // An empty enum would satisfy every `for (const v of ALL)` below.
        expect(ALL.length).toBeGreaterThanOrEqual(7);
        expect(ALL).toContain('SPRAY');
        expect(ALL).toContain('HARVEST');
    });

    it('every value is in the journal list localisation membership map', () => {
        expect(Object.keys(FIELD_OPERATION_TYPES).sort()).toEqual([...ALL].sort());
    });

    it.each(['bg', 'en'])('every value has a %s label', (loc) => {
        // Through `readCatalogue`, never a path of our own:
        // `one-catalogue-reader.test.ts` holds `tests/helpers/catalogue.ts` as
        // the ONE module allowed to know where the catalogue lives, so that
        // `messages/` can be re-split without touching any caller. A direct
        // read passes locally and reddens that guard in CI, which is how this
        // file first failed.
        const labels = (readCatalogue(loc) as unknown as {
            journalEnums: { operationType: Record<string, string> };
        }).journalEnums.operationType;
        expect(Object.keys(labels).sort()).toEqual([...ALL].sort());
        // A key present but empty renders as nothing, which the key-count
        // comparison above cannot see.
        for (const [k, v] of Object.entries(labels)) {
            expect({ loc, key: k, empty: v.trim() === '' }).toEqual({ loc, key: k, empty: false });
        }
    });

    it('every value is an option on the automation filter', () => {
        // Keyed through the constant, not a string literal: a literal is the
        // very drift this file exists to catch, and `EVENT_LABELS['typo']` is
        // `undefined` rather than a type error.
        const field = EVENT_LABELS[AUTOMATION_EVENTS.SPRAY_JOB_STARTED]?.filterFields?.find(
            (f) => f.field === 'operationType',
        );
        // jest's `expect` takes no message argument (that is Playwright's),
        // which is why this file compares objects: the KEY carries the
        // explanation into the diff instead.
        expect({ operationTypeFilter: field !== undefined }).toEqual({ operationTypeFilter: true });
        const values = (field as { options?: { value: string }[] }).options?.map((o) => o.value) ?? [];
        expect(values.sort()).toEqual([...ALL].sort());
    });

    it('every value has a Bulgarian «Мероприятие» label, and none is blank', () => {
        expect(Object.keys(ACTIVITY_LABELS_BG).sort()).toEqual([...ALL].sort());
        for (const [k, v] of Object.entries(ACTIVITY_LABELS_BG)) {
            expect({ key: k, blank: v.trim() === '' }).toEqual({ key: k, blank: false });
        }
    });

    it('CULTIVATE is not labelled «Обработка» alone', () => {
        // In the БАБХ register «обработка» means a CHEMICAL treatment — the
        // form's table is «химични обработки». A row reading «Обработка –
        // 17,05 ха» in a document that also lists sprayings would be read as a
        // spraying by the person it is written for.
        expect(ACTIVITY_LABELS_BG.CULTIVATE).toBe('Обработка на почвата');
    });

    it('the create schema accepts a strict SUBSET, and the difference is named', () => {
        const src = readFileSync(path.join(ROOT, 'src/lib/schemas/index.ts'), 'utf8');
        const m = src.match(
            /CreateFieldOperationSchema[\s\S]*?operationType:\s*z\.enum\(\[([^\]]*)\]\)/,
        );
        expect({ foundCreateSchemaEnum: m !== null }).toEqual({ foundCreateSchemaEnum: true });
        const accepted = [...m![1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
        // Not empty, or every containment check below is vacuous.
        expect(accepted.length).toBeGreaterThan(0);

        // Subset, not equality.
        for (const v of accepted) expect(ALL).toContain(v);

        const difference = ALL.filter((v) => !accepted.includes(v)).sort();
        expect({ inNeitherAcceptListNorInputLess: difference }).toEqual({
            inNeitherAcceptListNorInputLess: Object.keys(INPUT_LESS).sort(),
        });
        // The bare-activity set and the difference are the same statement made
        // twice; if they drift, one of them is lying about why.
        expect(difference).toEqual([...BARE_ACTIVITY_KINDS].sort());
        for (const [k, why] of Object.entries(INPUT_LESS)) {
            expect({ k, explained: why.length > 40 }).toEqual({ k, explained: true });
        }
    });
});
