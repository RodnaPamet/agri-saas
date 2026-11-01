/**
 * The assistant PREPARES a draft; it never writes — #2578 phase 2, reshaped
 * by #2632.
 *
 * The refusals are the subject. A draft is offered to a person as a prefilled
 * form, so one the real route would refuse wastes their tap and their trust —
 * and an id the model invented would prefill a reference nobody chose.
 *
 * What changed at #2632: the kind was `journal-entry`, checked against the
 * whole of `CreateLogEntrySchema`. No MOUNTED create form posts that body on
 * either client, and a treatment draft cannot satisfy the production schema
 * anyway — `parcelIds`, `doseValue` and `doseUnitId` are all required and all
 * three are the person's to supply. So the draft schema is now a `.pick()` of
 * the human-readable fields, made `.partial()`, derived from the production
 * schema.
 */
import {
    ACTIVITY_KIND_VALUES,
    PROPOSAL_KINDS,
    PROPOSAL_SCHEMAS,
    proposeDraft,
    TREATMENT_KIND_VALUES,
} from '@/app-layer/ai/assistant/propose';
import { RecordDiaryTreatmentSchema, RecordFarmActivitySchema } from '@/lib/schemas';

describe('proposeDraft — treatment (#2632)', () => {
    it('prepares a partial draft with no id anywhere in it', () => {
        const out = proposeDraft('treatment', {
            kind: 'SPRAY',
            occurredOn: '2026-10-28',
            productName: 'Карате Зеон',
            doseValue: 0.15,
            targetNote: 'житна пиявица',
            phenophase: 'BBCH 31',
        });
        expect(out.ok).toBe(true);
        expect(out.proposal?.kind).toBe('treatment');
        expect(out.proposal?.draft).toMatchObject({
            kind: 'SPRAY',
            productName: 'Карате Зеон',
            doseValue: 0.15,
        });
        // The product travels as a NAME. Nothing resembling a record
        // reference — the person picks parcels and the unit in the form.
        expect(JSON.stringify(out.proposal?.draft)).not.toMatch(/Id"|Ids"/);
        expect(out.message).toMatch(/nothing has been saved/i);
    });

    it('REFUSES an id or a parcel list, rather than stripping it silently', () => {
        // A silent strip hands somebody a form missing the thing they asked
        // for, with nothing saying so.
        for (const extra of [
            { parcelIds: ['p1'] },
            { parcels: [{ parcelId: 'p1', treatedAreaHa: 1 }] },
            { productItemId: 'it-1' },
            { fertilizerItemId: 'it-2' },
            { doseUnitId: 'u-1' },
            { newProductCategory: 'PESTICIDE' },
        ]) {
            const out = proposeDraft('treatment', { kind: 'SPRAY', ...extra });
            expect({ extra: Object.keys(extra)[0], ok: out.ok }).toEqual({
                extra: Object.keys(extra)[0],
                ok: false,
            });
            expect(out.proposal).toBeNull();
        }
    });

    it('inherits the PRODUCTION types, not a hand-written copy', () => {
        // `quarantinePeriodDays` is an integer 0-365 on the real body. A client
        // expecting free text here would be wrong, which is exactly why the
        // schema is picked from production rather than retyped.
        expect(proposeDraft('treatment', { quarantinePeriodDays: 14 }).ok).toBe(true);
        expect(proposeDraft('treatment', { quarantinePeriodDays: 'две седмици' }).ok).toBe(false);
        expect(proposeDraft('treatment', { quarantinePeriodDays: 400 }).ok).toBe(false);
        // `occurredOn` carries the production YYYY-MM-DD regex.
        expect(proposeDraft('treatment', { occurredOn: '2026-10-28' }).ok).toBe(true);
        expect(proposeDraft('treatment', { occurredOn: '28.10.2026' }).ok).toBe(false);
        // And the kind enum cannot drift from the route's.
        expect(proposeDraft('treatment', { kind: 'SPRAY' }).ok).toBe(true);
        expect(proposeDraft('treatment', { kind: 'PRUNE' }).ok).toBe(false);
    });

    it('refuses an EMPTY draft — a blank form is not a prepared one', () => {
        // Every field is optional so the model may send what it knows, which
        // makes `{}` parse. A proposal carrying nothing would open a blank
        // form while claiming the assistant had prepared something.
        expect(proposeDraft('treatment', {}).ok).toBe(false);
        expect(proposeDraft('treatment', {}).message).toMatch(/empty/i);
    });
});

describe('proposeDraft — activity (#2632)', () => {
    it('prepares a draft and refuses parcels', () => {
        const out = proposeDraft('activity', {
            kind: 'HARVEST',
            occurredOn: '2026-07-15',
            harvestKg: 48_000,
        });
        expect(out.ok).toBe(true);
        expect(out.proposal?.kind).toBe('activity');
        expect(proposeDraft('activity', { kind: 'HARVEST', parcelIds: ['p1'] }).ok).toBe(false);
    });

    it('re-applies the cross-field rule the shape-pick DROPPED', () => {
        // Reading `.shape` lifts the fields and loses the schema's
        // `.superRefine`. Losing most of it is the point — it also enforces
        // `parcelIds`, which the person supplies — but one rule is about two
        // DRAFT fields: the real body refuses `harvestKg` on anything but a
        // HARVEST. Without re-applying it, a draft would open a form the
        // route then rejects.
        expect(proposeDraft('activity', { kind: 'HARVEST', harvestKg: 1000 }).ok).toBe(true);
        expect(proposeDraft('activity', { kind: 'PRUNE', harvestKg: 1000 }).ok).toBe(false);
        // Only when BOTH are present — the draft is partial by design, so a
        // harvest weight with no kind yet is still a usable prefill.
        expect(proposeDraft('activity', { harvestKg: 1000 }).ok).toBe(true);
        expect(proposeDraft('activity', { kind: 'PRUNE' }).ok).toBe(true);
    });

    it('does NOT draft a title — the server composes it', () => {
        // Both routes compose the title ("Defaults to the activity name and
        // the block, as the treatments route does"), neither client has a
        // title field, and `TreatmentEntryModal` says the same at its
        // optimistic row. A drafted title is a field no form consumes, and a
        // client that forwarded it would override a consistent scheme with a
        // model's prose. Raised by agrent-ios asking where to show it.
        expect(proposeDraft('treatment', { title: 'Пръскане' }).ok).toBe(false);
        expect(proposeDraft('activity', { title: 'Коситба' }).ok).toBe(false);
    });

    it('SOWING is not an activity — it is a SEED treatment', () => {
        // The treatment schema says why: сеитба applies a seed product at a
        // rate, so it belongs on the treatments route and its row is excluded
        // from both БАБХ tables. A client listing sowing as an activity kind
        // (agrent-ios did, and corrected it) would build the wrong prefill.
        expect([...ACTIVITY_KIND_VALUES]).not.toContain('SEED');
        expect([...ACTIVITY_KIND_VALUES]).not.toContain('SOW');
        expect([...TREATMENT_KIND_VALUES]).toContain('SEED');
        expect(proposeDraft('activity', { kind: 'SEED' }).ok).toBe(false);
        expect(proposeDraft('treatment', { kind: 'SEED' }).ok).toBe(true);
    });
});

describe('the proposal registry', () => {
    it('the kind set is closed and every kind has a schema', () => {
        expect([...PROPOSAL_KINDS]).toEqual(['treatment', 'activity']);
        for (const kind of PROPOSAL_KINDS) {
            expect(PROPOSAL_SCHEMAS[kind]).toBeDefined();
        }
    });

    it('every draft field exists on its PRODUCTION schema', () => {
        // The coupling that makes `.pick()` worth it: a field renamed on the
        // real body breaks this, rather than producing a draft the form
        // silently ignores. Derived from the schemas themselves, so it cannot
        // go stale against a hand-written list.
        const pairs: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
            [
                'treatment',
                (PROPOSAL_SCHEMAS.treatment as unknown as { shape: Record<string, unknown> }).shape,
                RecordDiaryTreatmentSchema.shape as unknown as Record<string, unknown>,
            ],
            [
                'activity',
                (PROPOSAL_SCHEMAS.activity as unknown as { shape: Record<string, unknown> }).shape,
                RecordFarmActivitySchema.shape as unknown as Record<string, unknown>,
            ],
        ];
        for (const [kind, draftShape, prodShape] of pairs) {
            const draftKeys = Object.keys(draftShape);
            expect(draftKeys.length).toBeGreaterThan(0);
            const strays = draftKeys.filter((k) => !(k in prodShape));
            expect({ kind, strays }).toEqual({ kind, strays: [] });
            console.log(`[proposal-kinds] ${kind}: ${draftKeys.length} draft field(s) — ${draftKeys.join(', ')}`);
        }
    });

    it('never throws, whatever it is handed', () => {
        // The model supplies these. A throw would end a stream that has
        // already sent a 200.
        for (const junk of [null, undefined, 'x', 42, [], { kind: 1 }]) {
            for (const kind of PROPOSAL_KINDS) {
                expect(() => proposeDraft(kind, junk)).not.toThrow();
                expect(proposeDraft(kind, junk).ok).toBe(false);
            }
        }
    });
});
