/**
 * The assistant PREPARES a draft; the person confirms it — #2578, reshaped by
 * #2632.
 *
 * ## The kind must name a form that EXISTS
 *
 * This file shipped with one kind, `journal-entry`, validated against
 * `CreateLogEntrySchema` — the body of `POST /journal`. The schema was real and
 * the server wrote nothing, which is what I checked. What I never asked is
 * which FORM opens the draft, and the answer was none, on either client:
 *
 *   - `<JournalEntryModal>` is mounted in exactly ONE place,
 *     `journal/[id]/page.tsx`, always with an `initial.id` — it is the EDIT
 *     path and reaches `PUT /journal/{id}`.
 *   - The journal list's «Нов запис» mounts `TreatmentEntryModal`, posting
 *     `/journal/treatments`. Its own comment records the ruling: "«Нов запис»
 *     records a TREATMENT, not a free-form note (#1740). The free-form form is
 *     replaced rather than hidden behind a flag: the owner ruled it replaced".
 *   - The phone dropped its free-form form on 2026-10-10 for the same ruling.
 *
 * So a proposal kind is a claim that a form will open filled, and it is only
 * true of a body some MOUNTED create form posts.
 * `tests/guards/proposal-kinds-have-a-form.test.ts` holds that.
 *
 * ## Why the draft canNOT be validated against the whole production schema
 *
 * #2609's rule was "validate the draft against the production schema", and for
 * a treatment that is unsatisfiable BY CONSTRUCTION: `parcelIds` is
 * `.min(1)`, and `doseValue` and `doseUnitId` are required. All three are the
 * person's to supply — parcels on the form's map step, the dose typed, the
 * unit picked from the catalogue.
 *
 * The rule was right about WHY and wrong about WHICH schema can express it. A
 * create body holds two different kinds of field — what a conversation can
 * determine, and what only the person in front of the form can — and checking
 * a draft against the whole thing conflates them.
 *
 * So the draft schema is a `.pick()` of the human-readable fields, made
 * `.partial()`, DERIVED from the production schema. A renamed or retyped field
 * still breaks the draft loudly, which was the point of validating against
 * production; the full schema still validates the POST the person submits,
 * which is where it belongs.
 *
 * ## No ids, ever
 *
 * `.strict()`, so a model reaching for `parcelIds`, `productItemId` or
 * `doseUnitId` is REFUSED rather than silently stripped — a silent strip hands
 * somebody a form missing the thing they asked for, with nothing saying so.
 * Confirmed against the phone (agrent-ios, 2026-11-01): its form is text-first
 * because products are TYPED and the server finds or creates them (owner,
 * 2026-10-09), and the parcels are chosen in step 2.
 */
import { z } from 'zod';

import { RecordDiaryTreatmentSchema, RecordFarmActivitySchema } from '@/lib/schemas';
import { CostCategorySchema, CreateCostEntrySchema } from '@/app-layer/schemas/grain.schemas';

/**
 * The kinds of thing the assistant may propose. A closed set, and every member
 * must name a body that a MOUNTED create form posts — see the guard.
 *
 * `activity` is PHONE-ONLY today: no web component posts `/journal/activities`.
 * That is a legitimate asymmetry rather than a bug, and it is written down here
 * so the next reader does not take the web gap for one. The web shows such a
 * proposal as text until it grows a form.
 */
export const PROPOSAL_KINDS = ['treatment', 'activity', 'cost'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export interface AssistantProposal {
    readonly kind: ProposalKind;
    /** An entity create body, PARTIAL. No id — nothing has been written. */
    readonly draft: Record<string, unknown>;
}

/**
 * The treatment fields a conversation can legitimately determine.
 *
 * Picked from `RecordDiaryTreatmentSchema` so the TYPES come from production:
 * `quarantinePeriodDays` is an integer 0-365 rather than the free text a
 * client might expect, `occurredOn` carries the YYYY-MM-DD regex, and the
 * `kind` enum cannot drift from the route's.
 *
 * Omitted, and each omission is a decision:
 *   - `parcelIds` / `parcels` — the person picks them on the map step.
 *   - `productItemId` / `fertilizerItemId` / `doseUnitId` — ids. A model cannot
 *     know a cuid, and `productName` / `fertilizerName` carry the typed name
 *     the server resolves.
 *   - `doseUnitId` in particular is REQUIRED on the real body and has no
 *     free-text twin, so a draft carries the dose VALUE and not its unit. The
 *     form requires the unit before its own check, so nothing is lost.
 *   - `newProductCategory` — a consequence of what the person picks, not
 *     something to pre-decide for them.
 */
const TREATMENT_DRAFT_FIELDS = [
    'kind',
    'occurredOn',
    'productName',
    'fertilizerName',
    'doseValue',
    'targetNote',
    'phenophase',
    'pppRegistrationNo',
    'quarantinePeriodDays',
    'applicationTechnique',
    // `title` is NOT drafted. Both routes COMPOSE it — the activity schema
    // says "Defaults to the activity name and the block, as the treatments
    // route does", and `TreatmentEntryModal` records the same at its
    // optimistic row: "the server composes the real title". Neither client has
    // a title field, so a drafted one is a field no form consumes — #2632's
    // defect one field down — and a client that DID forward it would override
    // a consistent server-side scheme with a model's prose. Reported by
    // agrent-ios, who asked where to put it; the answer is nowhere.
] as const;

/** The activity fields. `harvestKg` only means anything for a HARVEST. */
const ACTIVITY_DRAFT_FIELDS = ['kind', 'occurredOn', 'harvestKg'] as const;

/**
 * The expense fields a conversation can determine (owner, 2026-11-20: «the
 * assistant should also be able to add expenses»), picked from
 * `CreateCostEntrySchema`, the body `POST /grain/costs` and its batch take.
 *
 * Omitted, each a decision:
 *   - every id — `invoiceFileId`, `plantingId`, `seasonId`, `locationId`,
 *     `parcelId`, `leaseId`, `itemId`, `allocationParcelIds`. A model cannot
 *     know a cuid, and an invoice is a file the person attaches.
 *   - `currency` — the form books in the farm's currency; a model guessing it
 *     is how a 1 000 лв cost becomes 1 000 €.
 *   - `allocationBasis` — a CONSEQUENCE of `commodityCanonical`: a crop means
 *     `CROP`, no crop means the whole farm. The form decides it from that, in
 *     front of the person, rather than taking a second field that could
 *     disagree with the first.
 *   - `amountPerDca` and the payroll pair — input aids of the calculator's
 *     per-decare sheet. A conversation states a TOTAL ("платих 300 лв за
 *     нафта"), which is what `amount` is.
 *
 * `commodityCanonical` goes through the production transform, so «пшеница»
 * arrives as `wheat` and a word that is not a crop is refused for the model
 * to fix, exactly as the route would refuse it.
 */
const COST_DRAFT_FIELDS = ['category', 'amount', 'incurredOn', 'supplier', 'description', 'commodityCanonical'] as const;

/**
 * Lift named fields off a production schema's shape, refusing an unknown one.
 *
 * `.pick()` is what this would obviously be, and it does not work here:
 * `RecordDiaryTreatmentSchema` carries `.superRefine(refineParcelAreaList)`,
 * and zod throws `.pick() cannot be used on object schemas containing
 * refinements`. Worth recording how that was nearly missed — a probe asking
 * `typeof schema.pick === 'function'` answers TRUE, because the method exists;
 * only CALLING it fails. A probe that checks for a method rather than
 * performing the operation has no discriminating power.
 *
 * Reading the shape is better than `.pick()` would have been anyway: a field
 * that no longer exists on the real body throws AT MODULE LOAD naming itself,
 * rather than yielding a draft whose extra key the form silently ignores. That
 * loud failure is the whole reason to derive from production instead of
 * retyping the fields.
 */
function fieldsFrom(
    shape: Record<string, z.ZodTypeAny>,
    keys: readonly string[],
    schemaName: string,
): Record<string, z.ZodTypeAny> {
    const out: Record<string, z.ZodTypeAny> = {};
    for (const key of keys) {
        const field = shape[key];
        if (!field) {
            throw new Error(
                `propose.ts: "${key}" is not a field of ${schemaName}. The production body `
                    + `changed; update the draft field list in the same change rather than `
                    + `dropping the field, which would silently stop prefilling it.`,
            );
        }
        out[key] = field;
    }
    return out;
}

export const ProposeTreatmentArgs = z
    .object(
        fieldsFrom(
            RecordDiaryTreatmentSchema.shape as unknown as Record<string, z.ZodTypeAny>,
            TREATMENT_DRAFT_FIELDS,
            'RecordDiaryTreatmentSchema',
        ),
    )
    .partial()
    .strict();

export const ProposeActivityArgs = z
    .object(
        fieldsFrom(
            RecordFarmActivitySchema.shape as unknown as Record<string, z.ZodTypeAny>,
            ACTIVITY_DRAFT_FIELDS,
            'RecordFarmActivitySchema',
        ),
    )
    .partial()
    .strict()
    // Reading `.shape` lifts the FIELDS and drops the schema's
    // `.superRefine`, which is what lets this draft exist at all — the
    // refinement also enforces `parcelIds`, which the person supplies. But one
    // of its rules is about two DRAFT fields and is re-applied here: the real
    // body refuses `harvestKg` on anything but a HARVEST, so a draft carrying
    // both would open a form the route then rejects. Only checked when both
    // are present, because the draft is partial by design.
    .refine(
        (v) => {
            const d = v as { harvestKg?: number; kind?: string };
            return d.harvestKg === undefined || d.kind === undefined || d.kind === 'HARVEST';
        },
        { message: 'harvestKg belongs to a HARVEST' },
    );

/** An expense draft. Every field optional; `missingCostItems` says what is still needed. */
export const ProposeCostArgs = z
    .object(
        fieldsFrom(
            CreateCostEntrySchema.shape as unknown as Record<string, z.ZodTypeAny>,
            COST_DRAFT_FIELDS,
            'CreateCostEntrySchema',
        ),
    )
    .partial()
    .strict();

/**
 * What the MODEL may send to `propose_cost_entry`: the draft fields, with the
 * crop as the person SAID it (`crop`, «пшеница») rather than the canonical
 * slug the body stores. The tool hands it to `commodityCanonical`, whose
 * production transform resolves it in either language.
 */
export const ProposeCostToolArgs = ProposeCostArgs.omit({ commodityCanonical: true })
    .extend({ crop: z.string().min(1).max(64).optional() })
    .strict();

/** The categories a cost may carry, from the production enum — never retyped. */
export const COST_CATEGORY_VALUES = CostCategorySchema.options;

/**
 * What an expense draft still LACKS — the treatment rule (#3162) applied to a
 * cost: while anything is listed, the tool proposes nothing and the model
 * asks. Only what the route needs and a conversation can give: what it was
 * for and how much. The day defaults to today in the form, so it is not asked.
 */
export function missingCostItems(draft: { category?: unknown; amount?: unknown }): string[] {
    const missing: string[] = [];
    if (!draft.category) missing.push('category (what the expense was for)');
    if (draft.amount === undefined) missing.push('amount');
    return missing;
}

/**
 * What the MODEL may send to `propose_treatment` — agri-saas#3162.
 *
 * The draft fields above plus the farmer's own WORDS for the field and the
 * dose unit (owner ruling 2026-11-17: the assistant asks until the record is
 * complete, field included). Words, never ids: the server resolves them
 * (`place.ts`), so `.strict()` still refuses a `parcelIds` or a `doseUnitId`
 * from the model.
 */
export const ProposeTreatmentToolArgs = ProposeTreatmentArgs.extend({
    /** A block's name, «Север». */
    blockName: z.string().min(1).max(120).optional(),
    /** Parcel names or cadastral numbers. */
    parcelNumbers: z.array(z.string().min(1).max(64)).min(1).max(50).optional(),
    /** A crop, «пшеница»: every parcel growing it. */
    crop: z.string().min(1).max(60).optional(),
    /** The dose unit as said, «л/дка». The form matches it to its catalogue. */
    doseUnit: z.string().min(1).max(20).optional(),
}).strict();

/**
 * The draft keys that are NOT production fields, and the production field
 * each one stands in for (#3162). The form turns each into its production
 * field: the resolved parcels into `parcelIds`, the unit's label into the
 * catalogue's `doseUnitId`. Declared so the registry test can hold the
 * coupling — a stand-in for a field the real body no longer has fails there.
 */
export const DRAFT_STAND_INS: Readonly<Record<string, string>> = {
    chosenParcels: 'parcelIds',
    doseUnitLabel: 'doseUnitId',
};

/**
 * A treatment DRAFT as it rides the answer — the model's fields plus what the
 * SERVER resolved. `chosenParcels`, not `parcels`: the production body has a
 * `parcels` of another shape, and a draft key that collides with a body key
 * is a form prefilling the wrong thing.
 */
export const TreatmentDraftSchema = ProposeTreatmentArgs.extend({
    chosenParcels: z
        .array(z.object({ id: z.string().min(1), label: z.string().min(1), crop: z.string().min(1) }).strict())
        .min(1)
        .optional(),
    doseUnitLabel: z.string().min(1).max(20).optional(),
}).strict();

/** Kind → its draft schema. The registry the guard and `runTool` both read. */
export const PROPOSAL_SCHEMAS: Readonly<Record<ProposalKind, z.ZodType<unknown>>> = {
    treatment: TreatmentDraftSchema,
    activity: ProposeActivityArgs,
    cost: ProposeCostArgs,
};

/**
 * What a treatment draft still LACKS to be a complete ДНЕВНИК record —
 * agri-saas#3162. While anything is listed, the tool proposes nothing and the
 * model asks. The list is the register's: the field, the input, the dose with
 * its unit, the day, and for a spray what it was against.
 */
/**
 * The fields `missingTreatmentItems` reads, typed by hand: the draft schema's
 * shape is lifted from production through an index signature, so zod infers
 * its keys as `unknown` and the checks below would not typecheck against it.
 */
export interface TreatmentDraftView {
    readonly kind?: unknown;
    readonly occurredOn?: unknown;
    readonly productName?: unknown;
    readonly fertilizerName?: unknown;
    readonly doseValue?: unknown;
    readonly targetNote?: unknown;
    readonly doseUnitLabel?: string;
    readonly chosenParcels?: readonly unknown[];
}

export function missingTreatmentItems(draft: TreatmentDraftView): string[] {
    const missing: string[] = [];
    if (!draft.kind) missing.push('kind (spray, fertilise or sow)');
    if (!draft.chosenParcels?.length) missing.push('field (a block name, a parcel or cadastral number, or a crop)');
    if (draft.kind === 'FERTILIZE' ? !draft.fertilizerName : !draft.productName) {
        missing.push(draft.kind === 'FERTILIZE' ? 'fertiliser name' : draft.kind === 'SEED' ? 'seed variety' : 'product name');
    }
    if (draft.doseValue === undefined) missing.push('dose');
    if (!draft.doseUnitLabel) missing.push('dose unit (e.g. л/дка, кг/дка)');
    if (!draft.occurredOn) missing.push('date');
    if (draft.kind === 'SPRAY' && !draft.targetNote) missing.push('target (the pest, disease or weed)');
    return missing;
}

/**
 * The `kind` values each proposal admits, DERIVED from the production enum so
 * a JSON-Schema handed to the model cannot offer a value the route refuses.
 * Hand-writing these is how three of five work-item statuses came out wrong.
 */
export const TREATMENT_KIND_VALUES = RecordDiaryTreatmentSchema.shape.kind.options;
export const ACTIVITY_KIND_VALUES = RecordFarmActivitySchema.shape.kind.options;

export interface ProposalOutcome {
    readonly ok: boolean;
    /** Present only when the draft validated. */
    readonly proposal: AssistantProposal | null;
    /** For the MODEL to read — why its draft was refused, so it can retry. */
    readonly message: string;
}

/**
 * Validate a proposed draft. Writes nothing.
 *
 * Returns `ok: false` with a reason rather than throwing, for `runTool`'s
 * reason: the model can act on a refusal and cannot act on a dead stream.
 *
 * An EMPTY draft is refused. Every field is optional so the model may send
 * what it knows, but a proposal carrying nothing would open a blank form and
 * claim the assistant had prepared something.
 */
export function proposeDraft(kind: ProposalKind, args: unknown): ProposalOutcome {
    const schema = PROPOSAL_SCHEMAS[kind];
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
        return {
            ok: false,
            proposal: null,
            message: `Draft rejected: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
        };
    }
    const draft = parsed.data as Record<string, unknown>;
    if (Object.keys(draft).length === 0) {
        return {
            ok: false,
            proposal: null,
            message: 'Draft rejected: it is empty. Say at least what and when.',
        };
    }
    return {
        ok: true,
        proposal: { kind, draft },
        message: 'Draft prepared. The person confirms it; nothing has been saved.',
    };
}
