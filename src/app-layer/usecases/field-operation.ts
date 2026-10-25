import { isUniqueViolation } from '@/lib/errors/prisma';
import { RequestContext } from '../types';
import { assertCanRead, assertCanWrite, assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import {
    codedBadRequest,
    codedForbidden,
    codedNotFound,
    staleData,
} from '@/lib/errors/types';
import { afterCommit } from '@/lib/db/after-commit';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { createTask } from './task';
import { WorkItemRepository, TaskLinkRepository } from '../repositories/WorkItemRepository';
import { ParcelRepository } from '../repositories/ParcelRepository';
import { TERMINAL_WORK_ITEM_STATUSES } from '../domain/work-item-status';
import { recordInputApplication, type InputApplicationResult } from './inventory';
import { createItem } from './catalog';
import { traceAgUsecase } from '@/lib/observability';
import { logger } from '@/lib/observability/logger';
import { trace } from '@opentelemetry/api';
import { emitAutomationEvent } from '../automation';
import { enqueue } from '@/app-layer/jobs/queue';
import { sanitizePlainText } from '@/lib/security/sanitize';
import type { FieldOperationType } from '@prisma/client';
import { appliesAProduct } from '@/lib/operations/line-kind';
import { composeFarmActivityTitle } from '@/lib/journal/auto-title';
import { createLogEntryWithAudit } from './journal-write';
import { ACTIVITY_LABELS_BG, isBareActivityKind } from '@/lib/operations/activity-labels';


// Derived from the Prisma enum rather than restated. #2316 added three
// values; a hand-written union would have kept compiling while silently
// excluding them from every annotation that uses it.
type OperationType = FieldOperationType;
type ParcelStatus = 'PENDING' | 'DONE' | 'SKIPPED';

const TERMINAL_STATUSES: readonly string[] = TERMINAL_WORK_ITEM_STATUSES;

export interface CreateFieldOperationInput {
    title?: string;
    operationType?: OperationType;
    assigneeUserId: string;
    parcelIds: string[];
    // Exactly one input kind is supplied — a product OR a fertilizer (#3).
    // Within a kind, exactly one of the id or the NAME.
    productItemId?: string | null;
    /** A typed product name, resolved to the farm's own product or created. */
    productName?: string | null;
    doseValue?: number | null;
    doseUnitId?: string | null;
    fertilizerItemId?: string | null;
    /** The fertiliser counterpart of `productName`. */
    fertilizerName?: string | null;
    fertilizerDoseValue?: number | null;
    fertilizerDoseUnitId?: string | null;
    /**
     * What a `productName` matching nothing is created as. Defaults to
     * PESTICIDE.
     *
     * Needed because the category rule is one-sided: a fertiliser may be
     * sprayed, so a typed name on the product path may legitimately BE a
     * fertiliser — and creating it as a PESTICIDE would demand a ПРЗ
     * registration number it does not have. Raised by agrent-ios as a
     * consequence of the owner's relaxation, which it is.
     */
    newProductCategory?: 'PESTICIDE' | 'FERTILIZER' | null;
    /** БАБХ fields, consulted only when a typed name has to CREATE a product. */
    newProductRegistration?: {
        pppRegistrationNo?: string | null;
        quarantinePeriodDays?: number | null;
        activeIngredient?: string | null;
    } | null;
    /** Optional per-decare water-carrier rate for the spray tank (product only). */
    waterRateValue?: number | null;
    waterRateUnitId?: string | null;
    targetNote?: string | null;
    dueAt?: string | null;
    /** "Техника за приложение / Equipment" — one rig per job (БАБХ record). */
    applicationTechnique?: string | null;
}

interface ChosenInput {
    /** Exactly one is set — the caller gave an id or a name, never both. */
    itemId: string | null;
    itemName: string | null;
    doseValue: number;
    doseUnitId: string;
    isFertilizer: boolean;
    /**
     * The operation's kind, carried here so the category guard can ask about it.
     *
     * `isFertilizer` above cannot express it: it is a boolean, and there are now
     * three input-applying kinds. Keeping both rather than deriving one from the
     * other, because `isFertilizer` also selects which dose FIELDS were read,
     * which is a different question from which kind was declared.
     */
    kind: OperationType;
}

/**
 * Resolve the single input a field operation applies — a product XOR a
 * fertilizer (#3). Rejects both-present and neither-present (defence in depth;
 * `CreateFieldOperationSchema` already enforces the XOR at the HTTP boundary),
 * and requires the chosen kind's dose + unit.
 *
 * ## `null` means a BARE ACTIVITY, and it is declared rather than inferred
 *
 * #2316: pruning, cultivation and harvest apply nothing, so there is no input
 * to resolve. `null` says so.
 *
 * The discriminator is `operationType` being one of `BARE_ACTIVITY_KINDS` —
 * **never the absence of the product fields**. Inferring it from absence would
 * turn a client bug (forgot the product) into a silently recorded pruning, and
 * the refusal that currently catches that bug is the one this function has
 * always made. A default cannot carry a safety property.
 *
 * Both directions are enforced: a bare kind REFUSES an input, so a client
 * sending `PRUNE` with a product gets told rather than having the product
 * quietly dropped from a regulated record.
 */
function resolveChosenInput(input: CreateFieldOperationInput): ChosenInput | null {
    const hasProduct = !!input.productItemId || !!input.productName;
    const hasFertilizer = !!input.fertilizerItemId || !!input.fertilizerName;
    if (input.operationType != null && isBareActivityKind(input.operationType)) {
        if (hasProduct || hasFertilizer) {
            throw codedBadRequest(
                'ACTIVITY_APPLIES_NO_INPUT',
                `A ${input.operationType} activity applies no product or fertiliser. `
                    + 'Send neither, or record it as a spraying or a fertilisation.',
            );
        }
        return null;
    }
    if (hasProduct === hasFertilizer) {
        throw codedBadRequest('OPERATION_INPUT_AMBIGUOUS', 'Choose exactly one input — a product OR a fertilizer.');
    }
    // An id AND a name for the same kind is a client bug, not a preference to
    // resolve. Preferring one silently would make the other field look honoured
    // and send the operator's typed name nowhere.
    if (input.productItemId && input.productName) {
        throw codedBadRequest('OPERATION_INPUT_AMBIGUOUS', 'Send either productItemId or productName, not both.');
    }
    if (input.fertilizerItemId && input.fertilizerName) {
        throw codedBadRequest('OPERATION_INPUT_AMBIGUOUS', 'Send either fertilizerItemId or fertilizerName, not both.');
    }
    if (hasProduct) {
        if (input.doseValue == null || !input.doseUnitId) throw codedBadRequest('PRODUCT_DOSE_REQUIRED', 'A product dose and unit are required.');
        return {
            itemId: input.productItemId ?? null,
            itemName: input.productName ?? null,
            doseValue: input.doseValue,
            doseUnitId: input.doseUnitId,
            isFertilizer: false,
            // SPRAY unless the caller named a kind. SEED arrives here — a seed
            // is a product item with a rate, not a fertiliser.
            kind: input.operationType ?? 'SPRAY',
        };
    }
    if (input.fertilizerDoseValue == null || !input.fertilizerDoseUnitId) throw codedBadRequest('FERTILIZER_DOSE_REQUIRED', 'A fertilizer dose and unit are required.');
    return {
        itemId: input.fertilizerItemId ?? null,
        itemName: input.fertilizerName ?? null,
        doseValue: input.fertilizerDoseValue,
        doseUnitId: input.fertilizerDoseUnitId,
        isFertilizer: true,
        kind: 'FERTILIZE',
    };
}

/**
 * The category rule — ONE-SIDED, and the asymmetry is the whole of it.
 *
 *   fertiliser field  ⇒  the item MUST be `FERTILIZER`
 *   product field     ⇒  any category, INCLUDING `FERTILIZER`
 *
 * Owner ruling 2026-10-09, after implementing the symmetric version broke our
 * own demo fixture. `prisma/fixtures/ag-demo.ts` files «Aqua Ammonium 28%» —
 * category FERTILIZER — as a SPRAY at 3 L/ha through the product field, and
 * that is real agronomy rather than a mistake: liquid nitrogen goes through a
 * sprayer. A `product ⇒ not FERTILIZER` rule would have refused it.
 *
 * So the defect originally reported — "a fertiliser filed as a spray" — turns
 * out to be a legitimate operation, and only the other direction is wrong. A
 * PESTICIDE in the fertiliser field means a job whose `operationType` says
 * FERTILIZE while its input is a plant protection product, which files into the
 * wrong ДНЕВНИК table.
 *
 * Worth knowing that `ParcelDetailSheet.tsx:172` still filters fertilisers OUT
 * of the product picker. That is a UI convenience and is deliberately NOT
 * enforced here: the picker narrows what is easy to choose, this function
 * refuses only what is incoherent.
 */
/**
 * Does the item's category fit the operation's kind?
 *
 * Three rules, and they are deliberately NOT symmetric:
 *
 *   - `FERTILIZE` requires a `FERTILIZER` item. Previously nothing checked
 *     this, so a pesticide passed there was filed as a fertilisation.
 *   - `SEED` requires a `SEED` item — see below, this one is load-bearing.
 *   - `SPRAY` accepts ANY category, deliberately: a liquid fertiliser applied
 *     through a sprayer is a legitimate spraying. (The `productItemId`
 *     description contradicts this and is wrong — #2362.)
 *
 * ## Why SEED must be restrictive, when SPRAY is not
 *
 * #2316 excludes `SEED` lines from both БАБХ tables, because the form covers
 * «РАСТИТЕЛНОЗАЩИТНИ МЕРОПРИЯТИЯ И ТОРЕНЕ» and a sowing is neither.
 *
 * That exclusion is an ESCAPE HATCH if the kind is unconstrained: record a real
 * plant-protection treatment as `kind: SEED` with a pesticide item, and it
 * never appears in the regulated register. Requiring a `SEED`-category item
 * closes it — the kind that leaves the register is the one kind whose item must
 * match it.
 *
 * So the asymmetry is not inconsistency. `SPRAY` is permissive because every
 * category genuinely can be sprayed and the row still prints. `SEED` is
 * restrictive because its row does NOT print, and a door out of a regulated
 * document needs a lock the others do not.
 */
function assertCategoryMatchesKind(category: string, kind: OperationType): void {
    if (kind === 'FERTILIZE') {
        if (category === 'FERTILIZER') return;
        throw codedBadRequest(
            'FERTILIZER_EXPECTED',
            'That item is not a fertiliser. Use the product field for it, or choose a fertiliser.',
            { category },
        );
    }
    if (kind === 'SEED') {
        if (category === 'SEED') return;
        throw codedBadRequest(
            'SEED_EXPECTED',
            'That item is not a seed. A sowing records a seed variety — record a product '
                + 'application as a spraying or a fertilisation instead.',
            { category },
        );
    }
    return;
}

/**
 * The stock unit a new Item should default to, derived from the DOSE unit.
 *
 * A dose unit is a RATE (`l-per-ha`); an Item's `defaultUnit` is a stock unit
 * (`l`). Storing the rate would "work" — nothing enforces the dimension — and
 * would be wrong later, surfacing as an inventory figure in litres-per-hectare
 * that nobody can reconcile.
 *
 * There is no stored rate→base relation on `Unit`, only the key convention the
 * model documents (`"l-per-ha", "kg", "l"`). Measured over the seeded set, all
 * eight rate units follow it and every base exists:
 *
 *   g-per-dca  g-per-ha  -> g        l-per-dca  l-per-ha  -> l
 *   kg-per-dca kg-per-ha -> kg       ml-per-dca ml-per-ha -> ml
 *
 * So the derivation is sound today and `tests/guards/rate-units-have-a-base-unit.test.ts`
 * is what keeps it sound: a rate unit added without a resolvable base is a red
 * build rather than a surprise at the first typed product name.
 */
export function baseUnitKeyOf(doseUnitKey: string): string | null {
    const i = doseUnitKey.indexOf('-per-');
    if (i <= 0) return null;
    return doseUnitKey.slice(0, i);
}

/**
 * Turn the chosen input's id-or-name into an Item id.
 *
 * ## Why this runs BEFORE the operation's transaction
 *
 * Creating an Item can hit `Item_tenantId_name_active_key`, the partial
 * case-insensitive unique index, and a P2002 inside an interactive Postgres
 * transaction POISONS it — every later statement in that transaction fails, so
 * a catch-and-re-read would be recovering inside a dead transaction. Resolving
 * first means the race is handled in its own transaction and the operation's
 * transaction only ever sees a settled id.
 *
 * `createFieldOperation` already commits in two transactions for a related
 * reason (`createTask` opens its own, so `clientMutationId` is durable first),
 * so a third pre-transaction is the shape this usecase already has rather than
 * a new one.
 *
 * ## The lookup is case-insensitive because the CONSTRAINT is
 *
 * The unique index is on `(tenantId, lower(name)) WHERE deletedAt IS NULL`. A
 * case-SENSITIVE find would miss «Карате Зеон» for a stored «КАРАТЕ ЗЕОН`,
 * then attempt a create, then take a P2002 — turning a successful match into a
 * 409 for the operator. The find and the constraint have to agree on what
 * "same name" means.
 */
async function resolveInputItemId(
    ctx: RequestContext,
    chosen: ChosenInput,
    registration: CreateFieldOperationInput['newProductRegistration'],
    newCategory: CreateFieldOperationInput['newProductCategory'],
): Promise<string> {
    if (chosen.itemId) return chosen.itemId;

    const name = sanitizePlainText((chosen.itemName ?? '').trim());
    if (!name) {
        throw codedBadRequest('PRODUCT_NAME_REQUIRED', 'A product name is required.');
    }

    const found = await runInTenantContext(ctx, (db) =>
        db.item.findFirst({
            where: {
                tenantId: ctx.tenantId,
                name: { equals: name, mode: 'insensitive' },
                deletedAt: null,
                // ── never resolve a typed name to an ARCHETYPE ──
                //
                // Raised by agrent-ios, and it is the defect this whole change
                // exists to remove rather than a detail. The seeded «Generic …»
                // products are still in the table and still in the unique
                // index; #1078 refuses to COMPLETE a line against one, because
                // ДНЕВНИК column 4 wants a trade name and an archetype is an
                // active-ingredient descriptor. So a lookup that matched one
                // would hand the operator a job that cannot be filed — the
                // exact "refused at the worst moment" shape free text was
                // introduced to avoid.
                //
                // The consequence worth knowing: an operator who types the
                // exact name of a SURVIVING archetype gets
                // `ITEM_NAME_ALREADY_EXISTS` from the create instead, because
                // `Item_tenantId_name_active_key` still sees it. That is a
                // comprehensible 409 rather than a job that dies at
                // completion, and it only arises for an archetype a past
                // record still uses — the ones the owner's removal keeps.
                isArchetype: false,
            },
            select: { id: true, category: true },
        }),
    );
    if (found) {
        // A matched name is used as-is. The regulatory fields in
        // `newProductRegistration` are IGNORED here rather than applied: this
        // call is creating an operation, not editing a product, and letting an
        // operation payload silently rewrite a stored ПРЗ № would make the
        // farm record editable from a surface nobody reviews it on.
        assertCategoryMatchesKind(found.category, chosen.kind);
        return found.id;
    }

    const doseUnit = await runInTenantContext(ctx, (db) =>
        db.unit.findUnique({ where: { id: chosen.doseUnitId }, select: { key: true } }),
    );
    if (!doseUnit) throw codedBadRequest('DOSE_UNIT_NOT_FOUND', 'Dose unit not found.');
    const baseKey = baseUnitKeyOf(doseUnit.key);
    const baseUnit = baseKey
        ? await runInTenantContext(ctx, (db) =>
              db.unit.findUnique({ where: { key: baseKey }, select: { id: true } }),
          )
        : null;
    if (!baseUnit) {
        // Loud rather than storing the rate unit as the stock unit. The guard
        // test should make this unreachable; if it fires, the convention it
        // guards has changed and the message says where to look.
        throw codedBadRequest(
            'DOSE_UNIT_HAS_NO_BASE',
            'That dose unit has no stock unit to create a product against. Create the product from the catalogue instead.',
            { doseUnit: doseUnit.key },
        );
    }

    // `createItem` rather than a local `db.item.create`: it holds
    // `assertPesticideIsFilable`, the name sanitisation, the unit check and the
    // P2002 → named-409 translation. A second implementation here is how the
    // regulatory rule ends up enforced on one path and not the other, which is
    // the mistake its own docblock describes being avoided once already.
    // The KIND decides the category wherever the kind constrains it, and
    // `newProductCategory` only chooses among the categories the kind allows.
    //
    //   FERTILIZE  →  FERTILIZER, always
    //   SEED       →  SEED, always
    //   SPRAY      →  PESTICIDE by default, FERTILIZER if asked
    //
    // The product path defaults to PESTICIDE — what a typed spray name usually
    // means — but accepts FERTILIZER, because a liquid fertiliser through a
    // sprayer is a legitimate spray and creating it as a PESTICIDE would demand
    // a ПРЗ number it has none of. Defaulting rather than requiring keeps every
    // existing caller working. An EXISTING item on this path may be any
    // non-FERTILIZER category, per the picker's own filter.
    //
    // ## SEED was missing here, and it broke сеитба two ways (#2316)
    //
    // `newProductCategory` is `'PESTICIDE' | 'FERTILIZER'`, so SEED was not
    // expressible, and a typed seed name fell to the PESTICIDE default. Then:
    //
    //   - `assertPesticideIsFilable` demanded a ПРЗ № and a quarantine period
    //     for a bag of wheat seed, which is the only thing a farmer sowing by
    //     name would ever see. «Сеитба» by name could not complete at all.
    //   - a caller that DID send `newProductRegistration` got past that and
    //     recorded a sowing against a PESTICIDE item — and because #2316
    //     excludes SEED from the БАБХ register, that plant protection product
    //     left the regulated document. The escape hatch `SEED_EXPECTED` closes
    //     on the found-by-id path was standing open on the create path.
    //
    // Raised by the agrent-ios session asking whether a new seed NAME creates a
    // SEED item. It did not.
    const category = chosen.isFertilizer
        ? 'FERTILIZER'
        : chosen.kind === 'SEED'
          ? 'SEED'
          : (newCategory ?? 'PESTICIDE');
    // A POSTCONDITION, and currently unreachable — say so rather than let it
    // read as the fix. What closes the hole is the derivation above: `category`
    // is computed FROM `chosen.kind`, so it cannot contradict it, and deleting
    // this line changes no observable behaviour (mutation-proved: dropping it
    // leaves all 11 cases green, while reverting the derivation fails three).
    //
    // It stays because it makes the invariant a property of the FUNCTION rather
    // than of one expression: both exits now pass through the same check, so a
    // later branch — a new kind, or a category made configurable again — gets a
    // 400 instead of writing a mismatched category into a regulated record.
    // That is defence in depth, not a demonstrated safeguard.
    assertCategoryMatchesKind(category, chosen.kind);

    const created = await createItem(ctx, {
        name,
        category,
        defaultUnitId: baseUnit.id,
        pppRegistrationNo: registration?.pppRegistrationNo ?? null,
        quarantinePeriodDays: registration?.quarantinePeriodDays ?? null,
        activeIngredient: registration?.activeIngredient ?? null,
    });
    return created.id;
}

function titleCase(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Resolve a FIELD_OPERATION's operation type for the БАБХ ДНЕВНИК generator,
 * which must split SPRAY (химични обработки) rows from FERTILIZE (торове)
 * rows. Prefers the persisted `Task.operationType`; for legacy rows written
 * before that column existed (always null) it derives from the title prefix
 * `createFieldOperation` minted (`"Spray — …"` / `"Fertilize — …"`).
 */
export function resolveOperationType(task: {
    operationType?: string | null;
    title?: string | null;
}): OperationType {
    if (task.operationType) return task.operationType as OperationType;
    const t = (task.title ?? '').trim().toLowerCase();
    if (t.startsWith('fertilize')) return 'FERTILIZE';
    if (t.startsWith('seed')) return 'SEED';
    if (t.startsWith('spray')) return 'SPRAY';
    return 'OTHER';
}

/**
 * Create a spray "job" over selected parcels of a Location:
 *   • one FIELD_OPERATION Task (assignee = operator) — created via
 *     `createTask`, so the assignment email + in-app bell come for free,
 *   • a Task→Location TaskLink (entityType LOCATION),
 *   • one OperationParcel prescription line per parcel (product + dose).
 *
 * The selection is validated BEFORE the task is created so a bad request
 * never leaves an orphan FIELD_OPERATION behind.
 */
/**
 * Offline exactly-once: reconstruct the create result for a Task that a
 * replayed request already minted (same outbox id → same idempotency key).
 * Returns the original 201 body so a re-send never doubles the job.
 */
async function findFieldOperationByMutationKey(
    ctx: RequestContext,
    locationId: string,
    idempotencyKey: string,
) {
    return runInTenantContext(ctx, async (db) => {
        const task = await db.task.findFirst({
            where: { tenantId: ctx.tenantId, clientMutationId: idempotencyKey, type: 'FIELD_OPERATION' },
            select: { id: true, key: true },
        });
        if (!task) return null;
        const parcelCount = await db.operationParcel.count({ where: { tenantId: ctx.tenantId, taskId: task.id } });
        return { taskId: task.id, taskKey: task.key, locationId, parcelCount };
    });
}

export async function createFieldOperation(
    ctx: RequestContext,
    locationId: string,
    input: CreateFieldOperationInput,
    idempotencyKey?: string | null,
    /**
     * For a caller that is recording work already DONE rather than handing it
     * to an operator (#1740's diary treatment).
     *
     * `suppressAssignmentNotification` exists because this function requires
     * an assignee, so a diary record's only honest assignee is the person
     * typing it — and they would otherwise be emailed and belled about work
     * they had just finished recording. See #1755 for the general case:
     * nothing compares the assignee against the actor, so ANY self-assignment
     * notifies today.
     *
     * `treatmentGroupId` stamps the task as one block's share of a treatment,
     * so the N tasks of one record share a handle.
     */
    opts?: { suppressAssignmentNotification?: boolean; treatmentGroupId?: string },
) {
    assertCanWrite(ctx);

    // Offline exactly-once — a queued spray job re-sent over a flaky link
    // carries the same outbox id as `Idempotency-Key`. If we already minted a
    // Task for that key, return the original result and do no further work.
    //
    // `parcelCount > 0` is the discriminator, and it is load-bearing (#931).
    // This create commits in TWO transactions: `createTask` opens its own, so
    // `clientMutationId` is durable BEFORE the TaskLink, operationType and
    // prescription lines are written by the second one below. If that second
    // transaction dies — a pod rolled mid-deploy, a connection reset, or
    // `createMany` over N parcels plus an encrypting `logEvent` exceeding
    // Prisma's 5s interactive default — it rolls back whole and the client
    // gets a 500.
    //
    // A 500 is transient, so the outbox keeps the item and replays it. This
    // arm used to answer that replay with 201 and `parcelCount: 0`, whereupon
    // the drain deleted the queued body as delivered and the operator was told
    // the job synced. The Task survives with no location link, a NULL
    // operationType and no lines; nothing can add lines afterwards (the
    // parcels route is PATCH-only) and the ДНЕВНИК joins Location → taskLink →
    // DONE operationParcel, so that treatment can never reach the compliance
    // record. `CreateFieldOperationSchema` requires `parcelIds.min(1)`, so
    // zero is unreachable for a healthy operation — it uniquely marks the
    // partial commit.
    //
    // So a zero-line hit is NOT a completed write. Fall through and finish the
    // job from this replay's body, which the outbox still holds precisely
    // because the first attempt failed. Refusing instead would be honest but
    // useless: the item would retry, refuse again, and park as `exhausted` —
    // and nothing clears that (#930), so the record would be stuck rather than
    // merely wrong.
    let repairTaskId: string | null = null;
    if (idempotencyKey) {
        const existing = await findFieldOperationByMutationKey(ctx, locationId, idempotencyKey);
        if (existing && existing.parcelCount > 0) return existing;
        if (existing) repairTaskId = existing.taskId;
    }

    // The operation applies exactly one input — a product XOR a fertilizer.
    const chosen = resolveChosenInput(input);
    // Resolve the id-or-name to an id BEFORE the transaction below — a P2002
    // from creating an Item would poison an interactive transaction, so the
    // create and its race live in their own. See `resolveInputItemId`.
    // A bare activity (#2316) has no id-or-name to resolve, so the Item create
    // and its P2002 race are skipped entirely rather than fed a null.
    const itemId =
        chosen === null
            ? null
            : await resolveInputItemId(
                  ctx,
                  chosen,
                  input.newProductRegistration,
                  input.newProductCategory,
              );
    // Water carrier only applies to a product spray (never a fertilizer line,
    // and never a bare activity — there is no tank).
    const waterRateValue = chosen === null || chosen.isFertilizer ? null : input.waterRateValue ?? null;
    const waterRateUnitId = chosen === null || chosen.isFertilizer ? null : input.waterRateUnitId ?? null;

    // 1 — validate location, parcels, the chosen input item, and its unit
    const location = await runInTenantContext(ctx, async (db) => {
        const loc = await db.location.findFirst({
            where: { id: locationId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, name: true },
        });
        if (!loc) throw codedNotFound('LOCATION_NOT_FOUND', 'Location not found');

        const valid = await ParcelRepository.validIdsForLocation(db, ctx, locationId, input.parcelIds);
        const missing = input.parcelIds.filter((id) => !valid.has(id));
        if (missing.length) throw codedBadRequest('PARCELS_NOT_IN_LOCATION', 'Some selected parcels do not belong to this location.');

        // Location and parcels are validated for EVERY kind above. What follows
        // is about the applied input, so a bare activity (#2316) skips it — there
        // is no item to find, no category to match and no dose unit to look up.
        if (chosen === null) return loc;
        if (itemId === null) {
            // Unreachable: `itemId` is null only when `chosen` is, and that
            // returned on the line above. A coded throw rather than a `!` so a
            // future change that breaks the pairing fails loudly instead of
            // querying `id: null` — which Prisma would read as "any item".
            throw codedBadRequest('PRODUCT_NOT_FOUND', 'Product not found.');
        }

        const item = await db.item.findFirst({
            where: { id: itemId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, category: true },
        });
        if (!item) throw codedBadRequest(
            chosen.isFertilizer ? 'FERTILIZER_NOT_FOUND' : 'PRODUCT_NOT_FOUND',
            chosen.isFertilizer ? 'Fertilizer not found.' : 'Product not found.',
        );
        // The category check applies to the ID path too, not only to a typed
        // name. This lookup previously selected `{ id: true }` and checked only
        // tenant and `deletedAt`, so a fertiliser's id passed as
        // `productItemId` was accepted and filed as a spray — while this file's
        // own comment asserted that "the kind is implicit in the Item's
        // category". A name resolved above has already been checked; doing it
        // here as well covers both and keeps one rule rather than two.
        assertCategoryMatchesKind(item.category, chosen.kind);

        const unit = await db.unit.findUnique({ where: { id: chosen.doseUnitId }, select: { id: true } });
        if (!unit) throw codedBadRequest('DOSE_UNIT_NOT_FOUND', 'Dose unit not found.');

        // Optional water-carrier rate: a rate value requires a unit, and the
        // unit must exist in the global catalog (like the dose unit above).
        if (waterRateValue != null) {
            if (!waterRateUnitId) throw codedBadRequest('WATER_RATE_UNIT_REQUIRED', 'A water-rate unit is required when a water rate is set.');
            const waterUnit = await db.unit.findUnique({ where: { id: waterRateUnitId }, select: { id: true } });
            if (!waterUnit) throw codedBadRequest('WATER_RATE_UNIT_NOT_FOUND', 'Water-rate unit not found.');
        }

        return loc;
    });

    // 2 — create the FIELD_OPERATION Task (reuses createTask's assignment
    //     notification path: email + in-app bell). The op type defaults from
    //     the chosen input kind (fertilizer → FERTILIZE, else SPRAY).
    const opType: OperationType =
        input.operationType
        ?? (chosen === null
            // Unreachable: `chosen` is null only when `operationType` names a
            // bare kind, so the left side of `??` has already won. Written out
            // rather than asserted away with `!`, which would be a claim the
            // compiler cannot check and the next reader cannot verify.
            ? 'OTHER'
            : chosen.isFertilizer
              ? 'FERTILIZE'
              : 'SPRAY');
    const title = input.title?.trim() || `${titleCase(opType)} — ${location.name}`;
    let task: { id: string; key: string | null };
    if (repairTaskId) {
        // Repairing a partial commit (#931) — the Task exists from the failed
        // attempt, so minting another would only hit the unique
        // (tenantId, clientMutationId) index. Finish THIS one.
        //
        // Bound to a const because the closure below outlives the narrowing:
        // `repairTaskId` is a reassignable `let` (the P2002 arm sets it too),
        // so TypeScript cannot prove it is still non-null inside the callback.
        const taskIdToRepair = repairTaskId;
        const found = await runInTenantContext(ctx, (db) =>
            db.task.findFirst({
                where: { id: taskIdToRepair, tenantId: ctx.tenantId },
                select: { id: true, key: true },
            }),
        );
        if (!found) throw codedNotFound('TASK_NOT_FOUND', 'Task not found');
        task = found;
    } else {
        try {
            task = await createTask(ctx, {
                title,
                type: 'FIELD_OPERATION',
                assigneeUserId: input.assigneeUserId,
                dueAt: input.dueAt ?? null,
                description: input.targetNote ?? null,
                clientMutationId: idempotencyKey ?? null,
                ...(opts?.suppressAssignmentNotification
                    ? { suppressAssignmentNotification: true }
                    : {}),
            });
        } catch (err) {
            // Race backstop — two replays of the same queued job hit the unique
            // (tenantId, clientMutationId) index concurrently. The loser gets a
            // P2002; re-read the winner's Task and return its result.
            //
            // The loser may re-read a row whose own second transaction has not
            // committed yet, so a zero-line read here is a RACE, not a partial
            // commit — returning it would hand back the empty result #931 is
            // about. Only a complete operation is a valid answer; otherwise
            // fall through and let the locked writer below settle it.
            if (idempotencyKey && isUniqueViolation(err)) {
                const existing = await findFieldOperationByMutationKey(ctx, locationId, idempotencyKey);
                if (existing && existing.parcelCount > 0) return existing;
                if (existing) {
                    repairTaskId = existing.taskId;
                    task = { id: existing.taskId, key: existing.taskKey };
                } else {
                    throw err;
                }
            } else {
                throw err;
            }
        }
    }

    // 3 — link Task→Location and write the per-parcel prescription lines
    const parcelCount = await runInTenantContext(ctx, async (db) => {
        // Serialise writers for THIS task. Two drains of one queued job — the
        // page sender and the service worker's background sync — can both
        // arrive here, and `OperationParcel` carries no unique on
        // (taskId, parcelId), so an unserialised second pass DOUBLES every
        // prescription line rather than colliding. Same mechanism as
        // `lockTaskStatusRow` (task.ts) and the journal's file dedupe;
        // transaction-scoped, released on commit or rollback.
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${ctx.tenantId}:field-op-lines:${task.id}`}))`;

        // Re-read INSIDE the lock. The loser of that race — and any repair
        // whose sibling finished while it waited — must not write a second
        // set of lines over a task that now has them.
        const already = await db.operationParcel.count({
            where: { tenantId: ctx.tenantId, taskId: task.id },
        });
        if (already > 0) return already;

        await TaskLinkRepository.link(db, ctx, task.id, 'LOCATION', locationId);

        // Persist the operation type + application technique on the Task so
        // the БАБХ ДНЕВНИК generator can split SPRAY (химични обработки) from
        // FERTILIZE (торове) rows without re-deriving from the title, and
        // fill the "Техника за приложение" column.
        await db.task.update({
            where: { id: task.id },
            data: {
                operationType: opType,
                ...(input.applicationTechnique !== undefined
                    ? { applicationTechnique: input.applicationTechnique }
                    : {}),
                // The treatment handle, when this task is one block's share
                // of a diary record (#1740). Written HERE rather than by the
                // caller afterwards so it commits in the same transaction as
                // the location link and the prescription lines: a task that
                // survived with lines but no handle would be invisible to the
                // PDF and the list, which is the partial-commit shape this
                // function already documents at length for the link itself.
                ...(opts?.treatmentGroupId
                    ? { treatmentGroupId: opts.treatmentGroupId }
                    : {}),
            },
        });

        // One prescription line per parcel for the single chosen input. The
        // line's `productItemId` holds the chosen Item (product or fertilizer);
        // the kind is implicit in the Item's category (there is no separate
        // input-kind column) and reflected in the Task's operationType.
        await db.operationParcel.createMany({
            data: input.parcelIds.map((parcelId) => ({
                tenantId: ctx.tenantId,
                taskId: task.id,
                parcelId,
                // All three together or none — which is exactly what
                // `OperationParcel_dose_all_or_nothing` enforces (#2316). A
                // chemical kind always has an `itemId` here (resolved above) and
                // a dose from `chosen`; a bare activity has neither.
                productItemId: itemId,
                doseValue: chosen === null ? null : chosen.doseValue,
                doseUnitId: chosen === null ? null : chosen.doseUnitId,
                waterRateValue,
                waterRateUnitId,
                targetNote: input.targetNote ?? null,
            })),
        });

        await logEvent(db, ctx, {
            action: 'SPRAY_JOB_STARTED',
            entityType: 'Task',
            entityId: task.id,
            details: `Created field operation ${task.key} over ${input.parcelIds.length} parcels`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Task',
                operation: 'created',
                after: {
                    operationType: opType,
                    locationId,
                    parcelCount: input.parcelIds.length,
                    assigneeUserId: input.assigneeUserId,
                },
                summary: `Created field operation ${task.key}`,
            },
        });

        return input.parcelIds.length;
    });

    // Field-workflow automation trigger (Epic 60 bus) — fires AFTER the
    // tx commits so a rule never acts on a rolled-back job. Mirrors the
    // SPRAY_JOB_STARTED audit action one-to-one.
    await emitAutomationEvent(ctx, {
        event: 'SPRAY_JOB_STARTED',
        entityType: 'Task',
        entityId: task.id,
        actorUserId: ctx.userId,
        stableKey: task.id,
        data: {
            taskId: task.id,
            taskKey: task.key,
            locationId,
            operationType: opType,
            parcelCount,
            productItemId: itemId,
            assigneeUserId: input.assigneeUserId,
        },
    });

    return { taskId: task.id, taskKey: task.key, locationId, parcelCount };
}

/**
 * The operator's view of a spray job: the Task, its per-parcel lines
 * (with product + dose + parcel), the linked Location, and the parcel
 * geometry (GeoJSON) for the read-only map.
 */
export async function getFieldOperation(ctx: RequestContext, taskId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const task = await db.task.findFirst({
            where: { id: taskId, tenantId: ctx.tenantId, type: 'FIELD_OPERATION' },
            include: { assignee: { select: { id: true, name: true, email: true } } },
        });
        if (!task) throw codedNotFound('FIELD_OPERATION_NOT_FOUND', 'Field operation not found');

        const lines = await db.operationParcel.findMany({
            where: { taskId, tenantId: ctx.tenantId },
            include: {
                product: { select: { id: true, name: true } },
                doseUnit: { select: { id: true, symbol: true, name: true } },
                waterRateUnit: { select: { id: true, symbol: true } },
                parcel: { select: { id: true, name: true, areaHa: true } },
                completedBy: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: 'asc' },
        });

        const link = await db.taskLink.findFirst({
            where: { taskId, tenantId: ctx.tenantId, entityType: 'LOCATION' },
            select: { entityId: true },
        });

        let location: { id: string; name: string; boundsJson: unknown } | null = null;
        let parcels: Awaited<ReturnType<typeof ParcelRepository.listForLocation>> = [];
        if (link) {
            location = await db.location.findFirst({
                where: { id: link.entityId, tenantId: ctx.tenantId },
                select: { id: true, name: true, boundsJson: true },
            });
            parcels = await ParcelRepository.listForLocation(db, ctx, link.entityId);
        }

        const total = lines.length;
        const done = lines.filter((l) => l.status === 'DONE' || l.status === 'SKIPPED').length;
        return { task, lines, location, parcels, progress: { total, done } };
    });
}

/**
 * Operator marks one prescription line DONE / SKIPPED (or back to
 * PENDING). The job auto-resolves (Task → RESOLVED) once no PENDING
 * lines remain. The assigned operator may act on their own job even
 * without general write permission.
 */
export async function markOperationParcel(
    ctx: RequestContext,
    taskId: string,
    lineId: string,
    status: ParcelStatus,
    note?: string | null,
    expectedVersion?: number,
    /**
     * An OPTIONS object rather than a seventh positional parameter. Six is
     * already past the point where a call site reads clearly, and the next
     * flag after this one would be indistinguishable from `expectedVersion`
     * at a glance.
     *
     * `recordedInDiary` reaches the INPUT_APPLICATION entry this mark emits
     * (#1740). Omitted means false, which is the operator path: a line
     * completed from a task in Задачи stays hidden from the journal list,
     * exactly as the 2026-10-10 ruling intends.
     */
    opts?: {
        recordedInDiary?: boolean;
        occurredAt?: Date;
        quarantinePeriodDays?: number | null;
        /** Фенофаза/BBCH observed on the day this line was applied (#2072). */
        phenophase?: string | null;
        /** Третирани площи in HECTARES; absent leaves the column alone (#2072). */
        treatedAreaHa?: number | null;
        treatmentGroupId?: string;
        /**
         * Join the CALLER's transaction instead of opening one (#2172).
         *
         * The #2172 correction route has to add or drop a parcel atomically
         * with the rest of a correction, and a nested `$transaction` on the same
         * client is not a nested transaction — it takes another connection and
         * deadlocks on the rows the outer one holds. So the caller passes its
         * `db` and this function writes inside it.
         *
         * Absent, the behaviour is exactly as before: open a tenant transaction
         * of its own. The `farm-record-pdf` enqueue moved to `afterCommit` so it
         * fires after the OUTERMOST transaction either way — standalone, that is
         * the same commit it already waited for.
         */
        tx?: PrismaTx;
    },
) {
    return traceAgUsecase('field-operation.markOperationParcel', ctx, () =>
        markOperationParcelImpl(ctx, taskId, lineId, status, note, expectedVersion, opts),
    );
}

async function markOperationParcelImpl(
    ctx: RequestContext,
    taskId: string,
    lineId: string,
    status: ParcelStatus,
    note?: string | null,
    expectedVersion?: number,
    opts?: {
        recordedInDiary?: boolean;
        occurredAt?: Date;
        quarantinePeriodDays?: number | null;
        /** Фенофаза/BBCH observed on the day this line was applied (#2072). */
        phenophase?: string | null;
        /** Третирани площи in HECTARES; absent leaves the column alone (#2072). */
        treatedAreaHa?: number | null;
        treatmentGroupId?: string;
        /**
         * Join the CALLER's transaction instead of opening one (#2172).
         *
         * The #2172 correction route has to add or drop a parcel atomically
         * with the rest of a correction, and a nested `$transaction` on the same
         * client is not a nested transaction — it takes another connection and
         * deadlocks on the rows the outer one holds. So the caller passes its
         * `db` and this function writes inside it.
         *
         * Absent, the behaviour is exactly as before: open a tenant transaction
         * of its own. The `farm-record-pdf` enqueue moved to `afterCommit` so it
         * fires after the OUTERMOST transaction either way — standalone, that is
         * the same commit it already waited for.
         */
        tx?: PrismaTx;
    },
) {
    const run = async (db: PrismaTx) => {
        const line = await db.operationParcel.findFirst({
            where: { id: lineId, taskId, tenantId: ctx.tenantId },
            include: {
                task: {
                    select: {
                        id: true,
                        assigneeUserId: true,
                        status: true,
                        key: true,
                        applicationTechnique: true,
                        // #2354 — a bare activity's journal entry takes its
                        // TYPE and its title from the activity kind.
                        operationType: true,
                    },
                },
                // #2354 — the parcel's name goes into that entry's title
                // params, so the row reads as something rather than as an id.
                parcel: { select: { name: true } },
                // For the archetype refusal below. Selected here rather than
                // fetched separately so the check cannot be skipped by a
                // caller that forgets it.
                product: { select: { name: true, isArchetype: true } },
            },
        });
        if (!line) throw codedNotFound('OPERATION_PARCEL_NOT_FOUND', 'Operation parcel not found');

        const isAssignee = line.task.assigneeUserId === ctx.userId;
        if (!ctx.permissions.canWrite && !isAssignee) {
            throw codedForbidden('OPERATION_NOT_ASSIGNED_TO_YOU', 'You can only update field operations assigned to you.');
        }

        // ── A spray may not be FILED against a seeded archetype (#1078) ──
        //
        // The ДНЕВНИК's column 4 is headed «Употребено средство за РЗ
        // /търговско наименование/» and the register joins this product live,
        // so completing a line against `Generic Chlorothalonil 720 SC` files a
        // regulated document naming a product that does not exist. The
        // archetypes are deliberate — a real proprietary label database is a
        // licensing problem — and the design has always been that an operator
        // replaces them.
        //
        // Refused at COMPLETION, not at planning: an operator mid-season can
        // still build a plan against a placeholder and correct it before
        // filing, and refusing earlier would block work that is not yet a
        // record of anything. Completion is the moment the row becomes
        // evidence.
        //
        // Only on the way INTO a done state. Reverting a line to PENDING must
        // stay possible whatever its product is, or a line filed before this
        // guard existed could never be corrected.
        if (status !== 'PENDING' && line.product?.isArchetype) {
            throw codedBadRequest(
                'PRODUCT_IS_SAMPLE_ARCHETYPE',
                `"${line.product.name}" is a sample product, not a registered one. ` +
                    `The farm record requires a product's trade name, so add your ` +
                    `own product and select it before completing this operation.`,
                { product: line.product.name },
            );
        }

        const fromStatus = line.status;
        // Optimistic lock — a mark queued offline carries the row version it
        // saw. If a supervisor/reviewer changed the line meanwhile, reject the
        // stale write with 409 STALE_DATA (details carry the server's current
        // state so the client can offer keep-mine / take-server) rather than
        // silently clobbering. Online edits (no expectedVersion) skip the check.
        if (expectedVersion !== undefined && line.version !== expectedVersion) {
            // ALREADY APPLIED, not a conflict. This endpoint is queued by the
            // outbox, and a replay after a lost response carries the version
            // the operator saw BEFORE their own write landed — so the version
            // check fails on their own success. Treated as 409 it parked an
            // operator-facing conflict asking them to resolve keep-mine vs
            // take-server AGAINST THEMSELVES, which is not a question anyone
            // can answer.
            //
            // If the line already carries the status this write wanted, the
            // intent is satisfied: return the current state and write no
            // second audit row. (If somebody else set the same status, the
            // operator's intent is still satisfied and that change has its own
            // audit row — so this is right in that case too.)
            if (line.status === status) {
                // SAME SHAPE as the success path below — this value is the
                // API response and is read post-transaction. `resolved: false`
                // matters: it is what stops the БАБХ farm-record regeneration
                // being enqueued a second time for one operator action.
                // `version` is the CURRENT one, so the client syncs to truth
                // rather than to the number it optimistically expected.
                return {
                    success: true as const,
                    resolved: false,
                    application: null,
                    version: line.version,
                    alreadyApplied: true as const,
                };
            }
            throw staleData('This job changed while you were offline.', {
                currentVersion: line.version,
                currentStatus: line.status,
                expectedVersion,
            });
        }
        const upd = await db.operationParcel.updateMany({
            where: {
                id: lineId,
                tenantId: ctx.tenantId,
                ...(expectedVersion !== undefined ? { version: expectedVersion } : {}),
            },
            data: {
                status,
                // `opts.occurredAt` is the treatment's own day for a backdated
                // diary record (#1740); `new Date()` is right for an operator
                // marking a line in the field today. A line stamped with the
                // save time rather than the treatment's day disagrees with
                // the journal entry it emits, and the БАБХ register joins the
                // two.
                completedAt:
                    status === 'PENDING' ? null : (opts?.occurredAt ?? new Date()),
                completedByUserId: status === 'PENDING' ? null : ctx.userId,
                // Карантинен срок as it applied ON THE DAY (#1775). Captured
                // here because this is the moment the line becomes a register
                // entry; `Item.quarantinePeriodDays` is editable, so reading
                // the product at generation time lets a reprint change.
                //
                // Only written when the caller supplies one, and cleared on a
                // revert to PENDING so a line put back into play does not
                // carry a period from a completion that was undone.
                ...(status === 'PENDING'
                    ? { quarantinePeriodDays: null }
                    : opts?.quarantinePeriodDays !== undefined
                      ? { quarantinePeriodDays: opts.quarantinePeriodDays }
                      : {}),
                // Фенофаза/BBCH, on the same terms as the period above
                // (#2072): written only when the caller supplies one, and
                // cleared on a revert to PENDING — a line put back into play
                // must not carry a growth stage observed for a completion
                // that was undone. The stage is a point-in-time observation,
                // so a stale one is worse than an absent one.
                ...(status === 'PENDING'
                    ? { phenophase: null }
                    : opts?.phenophase !== undefined
                      ? { phenophase: opts.phenophase }
                      : {}),
                // Третирани площи (#2072 part B), on the same terms: written
                // only when supplied, and cleared on a revert to PENDING so a
                // line put back into play reverts to meaning the whole parcel
                // rather than keeping an area from an undone completion.
                ...(status === 'PENDING'
                    ? { treatedAreaHa: null }
                    : opts?.treatedAreaHa !== undefined
                      ? { treatedAreaHa: opts.treatedAreaHa }
                      : {}),
                ...(note !== undefined ? { targetNote: note } : {}),
                // Every mutation bumps the version so the NEXT reader/replayer
                // sees a fresh number.
                version: { increment: 1 },
            },
        });
        if (upd.count === 0) {
            // Lost the race between the read above and this write — re-read the
            // current version so the client resolves against fresh state.
            const fresh = await db.operationParcel.findFirst({
                where: { id: lineId, tenantId: ctx.tenantId },
                select: { version: true, status: true },
            });
            // ALREADY APPLIED, exactly as in the pre-check arm above (#935).
            //
            // This arm used to throw unconditionally, so ONE queued mark got
            // two different answers depending only on timing: drained
            // sequentially it returned 200 `alreadyApplied`, but drained
            // CONCURRENTLY — the page sender and the service worker replaying
            // the same item, which is routine and is the race
            // `lockTaskStatusRow` exists for — the loser read the line BEFORE
            // the winner's write, passed the version pre-check, lost the CAS,
            // and 409d.
            //
            // The operator then got a conflict against their own successful
            // write, asking them to resolve keep-mine versus take-server
            // against themselves. #913 removed that question from the
            // sequential path and #923 mirrored it into `setTaskStatus`; this
            // is the concurrent path of the same fix.
            if (fresh && fresh.status === status) {
                return {
                    success: true as const,
                    resolved: false,
                    application: null,
                    version: fresh.version,
                    alreadyApplied: true as const,
                };
            }
            throw staleData('This job changed while you were offline.', {
                currentVersion: fresh?.version ?? null,
                currentStatus: fresh?.status ?? null,
                expectedVersion,
            });
        }

        await logEvent(db, ctx, {
            action: 'OPERATION_PARCEL_MARKED',
            entityType: 'OperationParcel',
            entityId: lineId,
            details: `Parcel prescription ${fromStatus} → ${status}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'OperationParcel',
                fromStatus,
                toStatus: status,
            },
        });

        trace.getActiveSpan()?.setAttributes({
            'ag.taskId': taskId,
            'ag.operationParcelId': lineId,
            'ag.parcelId': line.parcelId,
            'ag.status': status,
            'ag.doseValue': Number(line.doseValue),
        });

        // Phase 1 — completing a line (from a non-DONE state) makes it a
        // compliant, inventory-accurate spray record: emit the
        // INPUT_APPLICATION journal entry + the CONSUMPTION ledger entry
        // against the product's FEFO lot. Module-gated (JOURNAL /
        // INVENTORY) inside recordInputApplication; a no-op when both are
        // off, so this is backward-compatible with Feature 1. Un-completing
        // does NOT auto-reverse (the ledger is append-only — post an
        // ADJUSTMENT); re-completing re-emits a fresh application.
        let application: InputApplicationResult | null = null;
        // A bare activity line (#2316) applies no product, so there is no
        // stock movement to record. Guarded here rather than inside
        // `recordInputApplication`: that function's contract IS a product
        // application, and handing it a null product would make the absence
        // its problem to interpret.
        //
        // #2354: the `appliesAProduct` guard below was right about STOCK and
        // wrong about the JOURNAL. `recordInputApplication` is also the only
        // writer of the completed line's `LogEntry`, and the journal list reads
        // `LogEntry` — so skipping it skipped both, and a bare activity was
        // recorded into a register nobody could see. The else-branch writes the
        // entry that was missing.
        if (status === 'DONE' && fromStatus !== 'DONE' && appliesAProduct(line)) {
            application = await recordInputApplication(db, ctx, {
                id: line.id,
                parcelId: line.parcelId,
                productItemId: line.productItemId,
                doseValue: line.doseValue,
                doseUnitId: line.doseUnitId,
                recordedInDiary: opts?.recordedInDiary ?? false,
                ...(opts?.occurredAt ? { occurredAt: opts.occurredAt } : {}),
                ...(opts?.treatmentGroupId ? { treatmentGroupId: opts.treatmentGroupId } : {}),
            });

            // БАБХ farm-record completion snapshot: freeze the applicator's
            // certificates + the application technique into the
            // INPUT_APPLICATION LogEntry.conditionsJson AT THIS MOMENT, in the
            // SAME transaction as the journal write so they commit atomically.
            // Auditability — a later cert renewal (edit on the membership) must
            // not rewrite the historical record. The generator falls back to
            // live membership values for legacy rows that predate this
            // snapshot. The applicator is the assigned operator (who may also
            // be the one marking the line), else the actor. Skipped when
            // JOURNAL is off (no journalEntryId).
            if (application?.journalEntryId) {
                const applicatorUserId = line.task.assigneeUserId ?? ctx.userId;
                const membership = await db.tenantMembership.findUnique({
                    where: { tenantId_userId: { tenantId: ctx.tenantId, userId: applicatorUserId } },
                    select: {
                        applicatorCertNo: true,
                        agronomistCertNo: true,
                        agronomistName: true,
                    },
                });
                const existing = await db.logEntry.findUnique({
                    where: { id: application.journalEntryId },
                    select: { conditionsJson: true },
                });
                const priorConditions =
                    existing?.conditionsJson && typeof existing.conditionsJson === 'object'
                        ? (existing.conditionsJson as Record<string, unknown>)
                        : {};
                await db.logEntry.update({
                    where: { id: application.journalEntryId },
                    data: {
                        conditionsJson: {
                            ...priorConditions,
                            operatorCertNo: membership?.applicatorCertNo ?? null,
                            agronomistName: membership?.agronomistName ?? null,
                            agronomistCertNo: membership?.agronomistCertNo ?? null,
                            applicationTechnique: line.task.applicationTechnique ?? null,
                        },
                    },
                });
            }
        } else if (status === 'DONE' && fromStatus !== 'DONE' && !appliesAProduct(line)) {
            // ── #2354: a bare activity's journal entry ──────────────────────
            //
            // Written HERE because the branch above is the only other writer of
            // a completed line's entry, and the journal list reads `LogEntry`.
            // Without this a pruning existed as a Task and three DONE lines
            // that the farmer could not see anywhere.
            //
            // The TYPE is the activity's own, not `INPUT_APPLICATION`: nothing
            // was applied. `LogEntryType` already carries both values needed,
            // so this costs no migration.
            const entryType = line.task.operationType === 'HARVEST' ? 'HARVEST' : 'ACTIVITY';
            const parcelName = line.parcel?.name ?? '';
            const composed = await composeFarmActivityTitle({
                activity:
                    ACTIVITY_LABELS_BG[
                        (line.task.operationType ?? 'OTHER') as keyof typeof ACTIVITY_LABELS_BG
                    ],
                parcel: parcelName,
            });
            await createLogEntryWithAudit(
                db,
                ctx,
                {
                    type: entryType,
                    recordedInDiary: opts?.recordedInDiary ?? false,
                    // Spread rather than an explicit undefined, matching the
                    // product path: these columns have their own defaults and a
                    // written undefined is a write of nothing.
                    ...(opts?.treatmentGroupId ? { treatmentGroupId: opts.treatmentGroupId } : {}),
                    ...(opts?.occurredAt ? { occurredAt: opts.occurredAt } : {}),
                    title: composed.title,
                    titleKey: composed.titleKey,
                    titleParams: composed.titleParams,
                    operationParcelId: line.id,
                    // No quantities here. A harvest's «Продукция» is ONE total
                    // for the whole activity (owner, 2026-10-25) and this runs
                    // per LINE, so writing it here would produce one per parcel
                    // — the apportioning that ruling rejected. The activity
                    // usecase attaches it to a single entry afterwards.
                },
                'field_operation',
            );
        }

        // Auto-resolve the job when no PENDING lines remain.
        let resolved = false;
        if (status !== 'PENDING' && !TERMINAL_STATUSES.includes(line.task.status)) {
            const pending = await db.operationParcel.count({
                where: { taskId, tenantId: ctx.tenantId, status: 'PENDING' },
            });
            if (pending === 0) {
                // Review gate (#6): completing the last parcel sends the job
                // to PENDING_REVIEW (not straight to RESOLVED). A reviewer
                // (ADMIN) approves → RESOLVED, or requests changes → IN_PROGRESS
                // (see reviewFieldOperation). The ДНЕВНИК register + automation
                // signal still fire here — the field work IS done; review gates
                // only the task's finalisation.
                await WorkItemRepository.setStatus(db, ctx, taskId, 'PENDING_REVIEW', null);
                await logEvent(db, ctx, {
                    action: 'TASK_STATUS_CHANGED',
                    entityType: 'Task',
                    entityId: taskId,
                    details: 'Field operation completed — awaiting review',
                    detailsJson: {
                        category: 'status_change',
                        entityName: 'Task',
                        fromStatus: line.task.status,
                        toStatus: 'PENDING_REVIEW',
                        reason: 'All parcels completed — awaiting review',
                    },
                });
                resolved = true;
            }
        }

        trace.getActiveSpan()?.setAttribute('ag.jobResolved', resolved);

        // Field-workflow automation trigger (Epic 60 bus) — emitted at the
        // tail of the tenant tx, once `resolved` is known. Mirrors the
        // OPERATION_PARCEL_MARKED audit action.
        await emitAutomationEvent(ctx, {
            event: 'OPERATION_PARCEL_MARKED',
            entityType: 'OperationParcel',
            entityId: lineId,
            actorUserId: ctx.userId,
            stableKey: `${lineId}:${status}`,
            data: {
                taskId,
                operationParcelId: lineId,
                parcelId: line.parcelId,
                status,
                jobResolved: resolved,
            },
        });

        // БАБХ farm-record — when the job auto-resolves, regenerate the
        // location's current-season ДНЕВНИК into its Farm-records register.
        // Fire-and-forget + fail-open: a Redis outage must never roll back the
        // completion the operator just recorded. jobId keyed on the task dedups
        // repeated resolve transitions.
        //
        // `afterCommit` rather than a statement after the transaction, which is
        // where this lived. Standalone the two are the same commit — but once a
        // caller can pass its own `tx` (#2172), "after the statement" would run
        // while the CALLER's transaction is still open, enqueueing a
        // regeneration for a correction that may still roll back. `afterCommit`
        // fires after the OUTERMOST transaction, which is the guarantee this
        // comment claimed all along.
        if (resolved) {
            afterCommit('farm-record-pdf:mark-operation-parcel', async () => {
                try {
                    await enqueue(
                        'farm-record-pdf',
                        { tenantId: ctx.tenantId, taskId },
                        { jobId: `farm-record-${taskId}` },
                    );
                } catch (err) {
                    logger.warn('farm-record-pdf enqueue failed (task completion unaffected)', {
                        component: 'usecase',
                        tenantId: ctx.tenantId,
                        taskId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            });
        }

        return { success: true, resolved, application, version: line.version + 1 };
    };

    // The caller's transaction when it supplied one, otherwise our own. Not
    // `runInTenantContext` unconditionally: a nested `$transaction` on the same
    // client takes another connection and deadlocks on the rows the outer one
    // holds.
    return opts?.tx ? await run(opts.tx) : await runInTenantContext(ctx, run);
}

/**
 * Review a completed field operation (#6).
 *
 * Separation of duties: the operator (EDITOR / canWrite) marks the parcels;
 * a distinct reviewer (ADMIN / canAdmin) approves or rejects — the ADMIN
 * gate is how "not the executing operator" is enforced by role tier
 * (mirroring `reviewEvidence`). Task-review and Evidence-review are DELIBERATELY
 * two separate actions: this gates the field-operation Task's finalisation,
 * while `reviewEvidence` governs the evidence artifact's lifecycle.
 *
 * State machine (only from PENDING_REVIEW):
 *   APPROVE          → RESOLVED   (finalise the job)
 *   REQUEST_CHANGES  → IN_PROGRESS (reopen for the operator to rework)
 */
export async function reviewFieldOperation(
    ctx: RequestContext,
    taskId: string,
    data: { action: 'APPROVE' | 'REQUEST_CHANGES'; comment?: string | null },
) {
    assertCanAdmin(ctx);
    const { action } = data;
    // This path writes `comment` straight to `Task.resolution` via
    // `WorkItemRepository.setStatus` — it does NOT go through `setTaskStatus`,
    // so it needs its own sanitise. The same value also reaches the audit
    // `details` text and the reviewer notification, so sanitising once here
    // covers all three readers.
    const comment = data.comment != null ? sanitizePlainText(data.comment) : data.comment;
    if (action !== 'APPROVE' && action !== 'REQUEST_CHANGES') {
        throw codedBadRequest('INVALID_REVIEW_ACTION', 'Invalid review action.');
    }

    return runInTenantContext(ctx, async (db) => {
        const task = await db.task.findFirst({
            where: { id: taskId, tenantId: ctx.tenantId },
            select: { id: true, status: true, type: true, title: true, assigneeUserId: true },
        });
        if (!task) throw codedNotFound('TASK_NOT_FOUND', 'Task not found');
        if (task.type !== 'FIELD_OPERATION') {
            throw codedBadRequest('NOT_A_FIELD_OPERATION_TASK', 'Only field-operation tasks can be reviewed here.');
        }
        if (task.status !== 'PENDING_REVIEW') {
            throw codedBadRequest(
                'TASK_NOT_AWAITING_REVIEW',
                // The STATUS stays out of the sentence and in `params`
                // (#1918). It was interpolated raw — "Task is PENDING_REVIEW"
                // — which is a wire enum in displayed copy, the same defect
                // #1919 found in the role refusals: untranslatable, and
                // meaningless to a farmer who has never seen the enum. A
                // client that wants to branch on it still can; a person reads
                // a sentence that does not name it.
                //
                // Nothing is lost by omitting it, because the remedy does not
                // depend on which status it is: only a task awaiting review
                // can be approved or sent back.
                'This task is not awaiting review, so it cannot be approved or sent back.',
                { status: task.status },
            );
        }

        const newStatus = action === 'APPROVE' ? 'RESOLVED' : 'IN_PROGRESS';
        const resolution = action === 'APPROVE' ? (comment || 'Approved') : null;
        await WorkItemRepository.setStatus(db, ctx, taskId, newStatus, resolution);

        await logEvent(db, ctx, {
            action: 'TASK_STATUS_CHANGED',
            entityType: 'Task',
            entityId: taskId,
            details: action === 'APPROVE'
                ? `Field operation approved${comment ? `: ${comment}` : ''}`
                : `Field operation sent back for changes${comment ? `: ${comment}` : ''}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'Task',
                fromStatus: 'PENDING_REVIEW',
                toStatus: newStatus,
                reason: comment || undefined,
            },
        });

        // Notify the operator who was assigned the job (graceful degrade when
        // unassigned — mirrors the Evidence review notification).
        if (task.assigneeUserId) {
            await db.notification.create({
                data: {
                    tenantId: ctx.tenantId,
                    userId: task.assigneeUserId,
                    type: 'TASK_ASSIGNED',
                    title: action === 'APPROVE'
                        ? `Field operation approved: ${task.title}`
                        : `Changes requested: ${task.title}`,
                    message: comment
                        || (action === 'APPROVE'
                            ? `Your field operation "${task.title}" was approved.`
                            : `Your field operation "${task.title}" needs changes.`),
                    linkUrl: `/farm-tasks/${taskId}`,
                },
            });
        }

        return { success: true, status: newStatus };
    });
}

/**
 * List the FIELD_OPERATION jobs for a Location (its Operations tab),
 * resolved through the Task↔Location TaskLink.
 */
export async function listLocationOperations(ctx: RequestContext, locationId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const links = await db.taskLink.findMany({
            where: { tenantId: ctx.tenantId, entityType: 'LOCATION', entityId: locationId },
            select: { taskId: true },
        });
        const taskIds = links.map((l) => l.taskId);
        if (taskIds.length === 0) return [];
        return db.task.findMany({
            where: { id: { in: taskIds }, tenantId: ctx.tenantId, type: 'FIELD_OPERATION' },
            include: {
                assignee: { select: { id: true, name: true, email: true } },
                _count: { select: { operationParcels: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
    });
}
