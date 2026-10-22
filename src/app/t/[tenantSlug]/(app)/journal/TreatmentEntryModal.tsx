'use client';

/**
 * «Нов запис» — a treatment record in two steps (#1740).
 *
 * This REPLACES the free-form journal entry form, by owner ruling recorded on
 * #1740: "Today's free-form «Нов запис» (type, title, notes, blocks) →
 * Replaced by this flow." The phone replaced its own on 2026-10-13; until this
 * landed, the same control recorded a treatment on a phone and a free-form
 * note on the web.
 *
 * Step 1 is the treatment. Step 2 is where it happened: a crop picker, then
 * that crop's parcels across EVERY block, as a list beside a map with the
 * selection shared both ways.
 *
 * ## One modal, two steps
 *
 * Not two modals. The draft has to survive going back, and the
 * unsaved-changes guard belongs to the whole flow rather than to each half —
 * a farmer who has typed a treatment and ticked nine parcels must not lose it
 * by pressing Escape on step 2.
 *
 * ## Step 3 is the review, and the step ITSELF is the confirmation
 *
 * The register is a regulated document and a recorded treatment stays final —
 * `journal/treatments/{handle}` serves GET and DELETE only, and the owner ruled
 * on 2026-10-22 that recorded treatments will not become editable (#2172 keeps
 * the constraints that made an amendment hard). So the only place to catch a
 * mistyped dose is before the write.
 *
 * There is deliberately NO separate confirmation tick. The owner's ruling, to
 * match `TreatmentCheckView` on the phone, which has shipped without one since
 * 2026-10-20: reading the step and pressing Save IS the confirmation, and two
 * surfaces disagreeing about how a farmer confirms the same regulated entry is
 * worse than either answer alone. An earlier draft of this step gated Save on a
 * tick keyed to the body signature so that editing afterwards revoked it; that
 * went with the tick.
 *
 * ## The idempotency key belongs to the OUTBOX
 *
 * `POST /journal/treatments` replays a reused key without comparing the body
 * (#1765), so a key held across an edit would return the earlier treatment,
 * report success and silently drop the correction. This file used to derive one
 * from the content for that reason; it no longer does. `offlineSubmit` mints an
 * id before the first attempt and reuses it for every replay (#924, #1830), and
 * on this route the key IS the treatment handle — see `submit` below. Nothing
 * here derives a key, and the two docblocks that said otherwise were describing
 * a mechanism that had already been replaced.
 *
 * ## Not an offline-outbox write
 *
 * `JournalEntryModal` enqueued. A treatment writes N tasks across N blocks and
 * the outbox's replay path assumes the flat `/journal` array, so queuing one
 * is a separate decision rather than a line of wiring — the same judgement
 * #1120 made for the insurance quote.
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { haToDca, trimNumber } from '@/lib/agro/rate-calc';
import type { OfflineSync } from '@/lib/offline/use-offline-sync';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import dynamic from 'next/dynamic';
import type { MapParcel } from '@/components/ui/map/MapCanvas';

/**
 * MapLibre, lazily and client-only — the same import every other map site in
 * this app uses.
 *
 * A static import put the whole MapLibre bundle in the JOURNAL LIST page's
 * chunk, paid for by every farmer opening the register whether or not they
 * ever record a treatment, and dropped the `ssr: false` the other three sites
 * carry deliberately. The map is also only rendered once a crop is chosen, so
 * static loading bought nothing in exchange.
 *
 * It being a lazy chunk is what `tests/guards/offline-spec-chunk-warmup.test.ts`
 * is about: an offline spec must wait for the chunk to LAND before cutting the
 * network, and the wait that looks obvious (the parcel list) appears while the
 * chunk is still in flight.
 */
const MapCanvas = dynamic(
    () => import('@/components/ui/map/MapCanvas').then((m) => m.MapCanvas),
    { ssr: false },
);
import { DatePicker } from '@/components/ui/date-picker';

type Kind = 'SPRAY' | 'FERTILIZE';

interface CropTotal {
    cropType: string;
    parcelCount: number;
    areaHaTotal: number;
}

interface ByCropParcel {
    id: string;
    name: string;
    areaHa: number | string | null;
    locationId: string;
    locationName: string;
    geometry: MapParcel['geometry'];
}

interface ItemOption {
    id: string;
    name: string;
    /** Filtered on client-side; see the reads below for why. */
    category?: string;
}

interface UnitOption {
    id: string;
    symbol: string;
}

/**
 * What the page learns from a save.
 *
 * Deliberately NOT the treatment handle. The write goes through the offline
 * outbox, whose `submit` answers an OUTCOME and discards the response body —
 * a queued write has no response to carry one. That is not a loss here: the
 * «Изтегли PDF» button lives on the folded ДНЕВНИК row and reads the handle
 * the SERVER put there, so no client ever needs to know it. A queued
 * treatment therefore shows as a row with no document until it is delivered,
 * which is the owner's ruling of 2026-10-14 stated exactly.
 */
export interface TreatmentSaved {
    delivery: 'sent' | 'queued' | 'conflict';
    /** For the optimistic row a queued write needs; the server composes the real title. */
    productName: string | null;
    occurredOn: string;
    parcelCount: number;
}

interface Props {
    open: boolean;
    setOpen: (next: boolean) => void;
    /**
     * The shared outbox `submit`, passed in rather than hooked here so a write
     * queued from this modal is counted by the page's own OfflineSyncBar.
     */
    offlineSubmit: OfflineSync['submit'];
    onSaved: (saved: TreatmentSaved) => void;
}

/** Every field that defines the treatment — the idempotency key's input. */
interface Draft {
    kind: Kind;
    occurredOn: string;
    productItemId: string | null;
    doseValue: string;
    doseUnitId: string | null;
    targetNote: string;
    applicationTechnique: string;
    quarantinePeriodDays: string;
}

const EMPTY_DRAFT: Draft = {
    kind: 'SPRAY',
    occurredOn: '',
    productItemId: null,
    doseValue: '',
    doseUnitId: null,
    targetNote: '',
    applicationTechnique: '',
    quarantinePeriodDays: '',
};

/**
 * Today, as LOCAL calendar parts.
 *
 * Not `toISOString().slice(0, 10)`, which is the UTC day: for a farmer in
 * Sofia between 00:00 and 03:00 that is YESTERDAY, and the same UTC-slice
 * mistake has now been made three times on this issue — in the server's
 * future-day guard, in the list's `occurredOn`, and in this form's
 * `DatePicker` conversion.
 */
function todayLocal(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * A fresh draft, dated TODAY.
 *
 * The ДНЕВНИК records work already done, and "today" is what a farmer
 * recording a spray they have just finished wants — so the date is a field
 * they correct, not one they must fill. The server refuses a future farm day
 * anyway, which is the case a default could otherwise walk into.
 *
 * Deliberately a function, not a constant: a constant computed at module load
 * would date every treatment by the day the TAB was opened, which for a phone
 * left open overnight in a vehicle is the wrong day in a regulated register.
 */
function emptyDraft(): Draft {
    return { ...EMPTY_DRAFT, occurredOn: todayLocal() };
}


export function TreatmentEntryModal({ open, setOpen, offlineSubmit, onSaved }: Props) {
    const t = useTranslations('journal.treatmentForm');
    const apiUrl = useTenantApiUrl();

    const [step, setStep] = useState<1 | 2 | 3>(1);
    const [draft, setDraft] = useState<Draft>(emptyDraft);
    const [crop, setCrop] = useState<string | null>(null);
    const [selected, setSelected] = useState<string[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
        setDraft((d) => ({ ...d, [key]: value }));

    // ── Step 1 reference data ───────────────────────────────────────────
    /**
     * `/items` and `/units` — the routes that exist.
     *
     * This read was `/catalog/items?category=PESTICIDE,FERTILIZER` and
     * `/catalog/units?measure=RATE`, and there is no `/catalog` API at all:
     * those two lines were the only references to it in the repository. A
     * farmer would have opened the form to an empty product picker and an
     * empty unit picker, with step one impossible to complete, because both
     * are required. The rendered tests could not see it — they mock
     * `useTenantSWR` BY KEY, so they answered a key the server never serves.
     * CI's E2E is what caught it; `tests/guards/swr-paths-resolve.test.ts`
     * now catches the class.
     *
     * NO `category` parameter, deliberately. `/items` takes a SINGLE
     * category (`where.category = filters.category as ItemCategory`), so a
     * comma-separated pair matches nothing — the second half of the same
     * defect. Fetching every item and narrowing here costs one request on a
     * list that is a few dozen rows per farm, and it shares a cache entry
     * with every other screen that reads `/items`.
     */
    const { data: items } = useTenantSWR<{ items?: ItemOption[] } | ItemOption[]>(
        open ? '/items' : null,
    );
    const { data: units } = useTenantSWR<{ units?: UnitOption[] } | UnitOption[]>(
        open ? '/units?measure=RATE' : null,
    );

    /** PESTICIDE and FERTILIZER only — a treatment is applied, not sown. */
    const treatmentItems = useMemo(() => {
        const list = Array.isArray(items) ? items : (items?.items ?? []);
        return list.filter(
            (i) => i.category === 'PESTICIDE' || i.category === 'FERTILIZER',
        );
    }, [items]);

    const itemOptions: ComboboxOption[] = useMemo(
        () => treatmentItems.map((i) => ({ value: i.id, label: i.name })),
        [treatmentItems],
    );
    const unitOptions: ComboboxOption[] = useMemo(() => {
        const list = Array.isArray(units) ? units : (units?.units ?? []);
        return list.map((u) => ({ value: u.id, label: u.symbol }));
    }, [units]);

    // ── Step 2 reference data ───────────────────────────────────────────
    const { data: cropData } = useTenantSWR<{ crops?: CropTotal[] }>(
        // `>= 2`, not `=== 2`: step 3 reviews these parcels, and a key that
        // went null on the way there would blank the thing being reviewed.
        open && step >= 2 ? '/parcels/by-crop' : null,
    );
    const { data: parcelData, isLoading: parcelsLoading } = useTenantSWR<{
        parcels?: ByCropParcel[];
    }>(open && step >= 2 && crop ? `/parcels/by-crop?crop=${encodeURIComponent(crop)}` : null);

    const cropOptions: ComboboxOption[] = useMemo(
        () =>
            (cropData?.crops ?? []).map((c) => ({
                value: c.cropType,
                // The count and area come from the server; the sentence is
                // composed here, because server-authored copy is what
                // `no-server-authored-user-copy` ratchets down.
                label: t('cropOption', { crop: c.cropType, count: c.parcelCount }),
            })),
        [cropData, t],
    );

    const parcels = useMemo(() => parcelData?.parcels ?? [], [parcelData]);
    const mapParcels: MapParcel[] = useMemo(
        () =>
            parcels.map((p) => ({
                id: p.id,
                name: p.name,
                areaHa: p.areaHa != null ? Number(p.areaHa) : null,
                geometry: p.geometry,
            })),
        [parcels],
    );

    /**
     * Changing the crop clears the selection.
     *
     * The parcel list is crop-scoped, so keeping ticks across a change would
     * submit parcels the farmer can no longer see — and the register would
     * record a treatment on a crop they did not pick.
     *
     * In the HANDLER and not in an effect on `crop`. Both are correct here,
     * and the handler is the honest one: this is a thing that happens when a
     * person picks a crop, not a projection of `crop` that React has to keep
     * in sync. The effect form also trips `react-hooks/set-state-in-effect`,
     * which this repo silences 157 times over (#1730) — so the cheap fix is
     * one more suppression nobody will ever read, and the right fix is this.
     */
    const chooseCrop = useCallback((next: string | null) => {
        setCrop(next);
        setSelected([]);
    }, []);

    /**
     * Closing resets everything, so the next open is clean.
     *
     * Also an event rather than an effect on `open`, and here that is load
     * bearing rather than stylistic: `Modal` calls `setShowModal(false)` only
     * once the close is REAL — its dirty-discard confirm runs first
     * (`modal.tsx:177-187`) — so this cannot wipe a form that is still on
     * screen behind a "discard?" prompt. Every close route funnels through
     * here: the overlay, Escape, the Cancel button, and a successful save.
     */
    const closeAndReset = useCallback(() => {
        setStep(1);
        setDraft(emptyDraft());
        setCrop(null);
        setSelected([]);
        setError(null);
        setOpen(false);
    }, [setOpen]);

    const dirty =
        JSON.stringify({ ...draft, occurredOn: '' }) !== JSON.stringify(EMPTY_DRAFT) ||
        selected.length > 0;

    const step1Complete =
        draft.occurredOn !== '' &&
        draft.productItemId !== null &&
        draft.doseValue.trim() !== '' &&
        draft.doseUnitId !== null;

    /**
     * The request body, and what step 3 reviews.
     *
     * The draft holds what was typed; the body holds what is SENT, trimmed and
     * with empty fields omitted. Reviewing the body rather than the draft is
     * what makes the step honest: an omitted optional field is absent from both,
     * instead of showing as an empty row that reads like a value of nothing.
     *
     * The idempotency key is the outbox's, not derived from this — see `submit`.
     *
     * The wording is load-bearing in a silly way. The previous sentence used
     * a colon where this one has a full stop, and `no-explicit-any-ratchet`
     * greps src/** for a colon followed by the escape-hatch keyword — so one
     * comma splice in prose raised the cap by one and reddened CI.
     *
     * That is the guard working as designed, not a bug in it:
     * `scripts/lib/any-patterns.ts` records counting comment mentions as a
     * deliberate decision, on the grounds that a comment naming the pattern
     * is usually evidence of the thing. 11 of the 131 counted occurrences are
     * prose today. So the fix is this rewording, and the pattern is
     * deliberately not quoted anywhere in this file.
     */
    const payload = useMemo(
        () => ({
            kind: draft.kind,
            occurredOn: draft.occurredOn,
            // SORTED here rather than at the request, so the key is
            // order-independent by construction: ticking two parcels in the
            // other order is the same treatment and must not mint a second
            // one. The server groups by block regardless of order.
            parcelIds: [...selected].sort(),
            ...(draft.productItemId ? { productItemId: draft.productItemId } : {}),
            doseValue: Number(draft.doseValue),
            doseUnitId: draft.doseUnitId,
            ...(draft.targetNote.trim() ? { targetNote: draft.targetNote.trim() } : {}),
            ...(draft.applicationTechnique.trim()
                ? { applicationTechnique: draft.applicationTechnique.trim() }
                : {}),
            ...(draft.quarantinePeriodDays.trim()
                ? { quarantinePeriodDays: Number(draft.quarantinePeriodDays) }
                : {}),
        }),
        [draft, selected],
    );


    /**
     * The chosen product's NAME, for the queue label and the optimistic row.
     *
     * Read from the ITEM LIST and not from `itemOptions`, whose `label` is a
     * `ReactNode` — a combobox option may render an element, so that field
     * cannot be handed to anything wanting a string. `ItemOption.name` is the
     * data behind the option and is typed `string`.
     */
    const productName = useMemo(
        () => treatmentItems.find((i) => i.id === draft.productItemId)?.name ?? null,
        [treatmentItems, draft.productItemId],
    );

    /**
     * The review rows, built from the PAYLOAD rather than the draft.
     *
     * So what is shown is what will be written: an omitted optional field is
     * absent from the body and absent here, instead of appearing as an empty
     * row that reads like a value of nothing. A farmer checking a regulated
     * entry should see the record, not the form.
     */
    const reviewRows = useMemo(() => {
        const unitSymbol = unitOptions.find((u) => u.value === draft.doseUnitId)?.label ?? null;
        const rows: { key: string; label: string; value: string }[] = [
            { key: 'kind', label: t('kind'), value: t(`kind_${draft.kind}`) },
            { key: 'occurredOn', label: t('occurredOn'), value: draft.occurredOn },
        ];
        if (productName) rows.push({ key: 'product', label: t('product'), value: productName });
        rows.push({
            key: 'dose',
            label: t('doseValue'),
            // Dose and unit on one line: «2 л/дка» is how it is written on the
            // form and read by an inspector, not as two unrelated fields.
            value: unitSymbol ? `${payload.doseValue} ${unitSymbol}` : String(payload.doseValue),
        });
        if (crop) rows.push({ key: 'crop', label: t('crop'), value: crop });
        if (payload.targetNote) {
            rows.push({ key: 'targetNote', label: t('targetNote'), value: payload.targetNote });
        }
        if (payload.applicationTechnique) {
            rows.push({
                key: 'technique',
                label: t('technique'),
                value: payload.applicationTechnique,
            });
        }
        if (payload.quarantinePeriodDays !== undefined) {
            rows.push({
                key: 'quarantine',
                label: t('quarantine'),
                value: String(payload.quarantinePeriodDays),
            });
        }
        return rows;
    }, [draft, crop, payload, productName, unitOptions, t]);

    /**
     * The parcels under review, in the order the body sends them.
     *
     * Mapped from `payload.parcelIds` and not from `selected`, for the reason
     * the rows above come from the payload: the sorted de-duplicated set is
     * what the server is asked to record. A parcel whose row has not loaded
     * shows its id rather than being dropped — a silently shorter list is the
     * one failure this screen exists to prevent.
     */
    const reviewParcels = useMemo(
        () =>
            payload.parcelIds.map((id) => {
                const row = parcels.find((x) => x.id === id);
                return {
                    id,
                    name: row?.name ?? id,
                    /**
                     * DECARES, converted here.
                     *
                     * Areas are stored in hectares throughout, and Bulgarian
                     * farmers work in декари — `lib/grain/per-area.ts` says so
                     * and the register's own column is «Площ (дка)»
                     * (`journal.colTreatedArea`). Showing hectares on a review
                     * screen for a regulated entry would be wrong by a factor
                     * of ten, in the direction that looks plausible. Same
                     * `haToDca` + `trimNumber` the locations table uses, so
                     * there is one conversion in the product rather than two.
                     */
                    areaDca: row?.areaHa != null ? trimNumber(haToDca(Number(row.areaHa))) : null,
                };
            }),
        [payload.parcelIds, parcels],
    );

    const submit = useCallback(async () => {
        if (submitting || selected.length === 0) return;
        setSubmitting(true);
        setError(null);
        try {
            /**
             * Through the OUTBOX, not straight to the network (#1830).
             *
             * `submit` tries the network first when online and queues on a
             * network failure, so a farmer who loses signal with the form
             * open does not lose the work — which is the capability
             * `journal-offline-create.spec.ts` has asserted since before this
             * form existed, and which replacing the free-form modal would
             * otherwise have deleted.
             *
             * The outbox also owns the `Idempotency-Key`: it mints an id
             * BEFORE the first attempt and reuses it for every replay
             * (#924), so an answer lost after the server committed cannot
             * write a second treatment. That is a stronger guarantee than
             * the content-derived key this file used to build, and it is the
             * house mechanism rather than a second one beside it — on this
             * route the key IS the treatment handle, so the handle is now
             * the outbox id.
             *
             * What it does NOT make offline-proof is step TWO's reads,
             * and the reason is specific rather than general. This form
             * reads `/catalog/items`, `/catalog/units` and
             * `/parcels/by-crop`; the web's persistent SWR cache
             * (`src/lib/swr/persistent-cache.ts`) writes only an
             * ALLOWLIST — `PERSISTABLE_PATHS` is `/journal`,
             * `/farm-tasks`, `/locations`, `/exchange/listings` — so none
             * of this form's four reads is on disk at all.
             *
             * So queuing covers losing signal MID-FORM, not opening the
             * form without signal: step two would have no crops to pick
             * and no parcels to tick (#1845).
             *
             * Recorded with its mechanism because I got this wrong twice:
             * first asserting the limit without checking, then "correcting"
             * it on finding that a persistence layer exists — without
             * checking whether it covers these keys. It does not.
             */
            const delivery = await offlineSubmit({
                url: apiUrl('/journal/treatments'),
                method: 'POST',
                body: payload,
                // What the OfflineSyncBar shows while it waits. The product
                // name is the farmer's own word for this treatment; the kind
                // is the fallback when a product was typed rather than picked.
                label:
                    productName ??
                    t(draft.kind === 'FERTILIZE' ? 'kind_FERTILIZE' : 'kind_SPRAY'),
                // NO supersede key, deliberately: every save MINTS a
                // treatment, so an older queued one is a different
                // treatment, not a stale version of this one.
                //
                // What a 2xx has to SAY before this counts as delivered
                // (#1870). This route is resumable rather than atomic: the
                // per-parcel mark writes each ДНЕВНИК entry, so a failure
                // part-way answers 201 with fewer parcels recorded than were
                // sent. Without this the outbox called that delivered and
                // dropped the item, and the remaining applications were
                // missing from a regulated register with nothing saying so.
                //
                // Compared against what we SENT, because the 201 carries no
                // `complete` flag — that lives on
                // `GET /journal/treatments/{handle}` by that schema's own
                // decision. `payload.parcelIds.length` rather than
                // `selected.size`: the payload is what the server was asked
                // to record, and it is the sorted de-duplicated set.
                //
                // Absent for a free-hand entry (no parcels), where a 201 with
                // `parcelCount: 0` is the correct finished answer and an
                // expectation of 0 would be satisfied by it anyway — but
                // omitting it keeps the body unparsed on that path.
                ...(payload.parcelIds.length > 0
                    ? {
                          completeWhen: {
                              field: 'parcelCount',
                              equals: payload.parcelIds.length,
                          } as const,
                      }
                    : {}),
            });
            onSaved({
                delivery,
                productName,
                occurredOn: draft.occurredOn,
                parcelCount: selected.length,
            });
            closeAndReset();
        } catch (e) {
            // A terminal 4xx throws out of `submit` — the sample-product
            // refusal and the cross-tenant parcel refusal both land here, and
            // the server's message is already localised for every coded one.
            setError(e instanceof Error ? e.message : t('saveFailed'));
        } finally {
            setSubmitting(false);
        }
    }, [apiUrl, closeAndReset, draft.kind, draft.occurredOn, offlineSubmit, onSaved, payload, productName, selected.length, submitting, t]);

    const heading =
        step === 1 ? t('stepOneTitle') : step === 2 ? t('stepTwoTitle') : t('stepThreeTitle');

    return (
        <Modal
            showModal={open}
            setShowModal={(next) => {
                const wantClose = typeof next === 'function' ? !next(true) : next === false;
                if (wantClose && submitting) return;
                if (wantClose) closeAndReset();
                else setOpen(typeof next === 'function' ? next(open) : next);
            }}
            size="lg"
            title={heading}
            isDirty={dirty}
            preventDefaultClose={submitting}
        >
            <Modal.Header title={heading} description={t('subtitle')} />
            <Modal.Form
                id="treatment-entry-form"
                onSubmit={(e) => {
                    e.preventDefault();
                    if (step === 1) setStep(2);
                    else if (step === 2) setStep(3);
                    else void submit();
                }}
            >
                {step === 1 ? (
                    <div className="space-y-default">
                        <FormField label={t('kind')} required>
                            <Combobox
                                selected={{ value: draft.kind, label: t(`kind_${draft.kind}`) }}
                                setSelected={(o) => o && set('kind', o.value as Kind)}
                                options={[
                                    { value: 'SPRAY', label: t('kind_SPRAY') },
                                    { value: 'FERTILIZE', label: t('kind_FERTILIZE') },
                                ]}
                                id="treatment-kind"
                            />
                        </FormField>

                        <FormField label={t('occurredOn')} required>
                            {/* The DRAFT holds a `YYYY-MM-DD` string, because
                                that is what the API takes and what the
                                idempotency key hashes; `DatePicker` is
                                Date-valued, so the conversion happens here
                                rather than letting a Date into the draft and
                                formatting it at the request. Converting on
                                the way IN keeps one representation of the
                                day. */}
                            <DatePicker
                                id="treatment-day"
                                value={draft.occurredOn ? new Date(`${draft.occurredOn}T00:00:00`) : null}
                                onChange={(d) =>
                                    set(
                                        'occurredOn',
                                        // Local parts, not `toISOString()`: that
                                        // would shift the day for a farmer east
                                        // of UTC picking a date near midnight —
                                        // the same UTC-slice mistake the server
                                        // guard had.
                                        d
                                            ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                                            : '',
                                    )
                                }
                            />
                        </FormField>

                        <FormField label={t('product')} required>
                            <Combobox
                                selected={
                                    itemOptions.find((o) => o.value === draft.productItemId) ?? null
                                }
                                setSelected={(o) => set('productItemId', o?.value ?? null)}
                                options={itemOptions}
                                placeholder={t('productPlaceholder')}
                                searchPlaceholder={t('productSearch')}
                                id="treatment-product"
                            />
                        </FormField>

                        <div className="grid gap-default sm:grid-cols-2">
                            <FormField label={t('doseValue')} required>
                                <Input
                                    id="treatment-dose"
                                    inputMode="decimal"
                                    value={draft.doseValue}
                                    onChange={(e) => set('doseValue', e.target.value)}
                                />
                            </FormField>
                            <FormField label={t('doseUnit')} required>
                                <Combobox
                                    selected={
                                        unitOptions.find((o) => o.value === draft.doseUnitId) ?? null
                                    }
                                    setSelected={(o) => set('doseUnitId', o?.value ?? null)}
                                    options={unitOptions}
                                    id="treatment-unit"
                                />
                            </FormField>
                        </div>

                        <FormField label={t('targetNote')}>
                            <Input
                                id="treatment-pest"
                                value={draft.targetNote}
                                onChange={(e) => set('targetNote', e.target.value)}
                            />
                        </FormField>

                        <div className="grid gap-default sm:grid-cols-2">
                            <FormField label={t('technique')}>
                                <Input
                                    id="treatment-technique"
                                    value={draft.applicationTechnique}
                                    onChange={(e) => set('applicationTechnique', e.target.value)}
                                />
                            </FormField>
                            <FormField label={t('quarantine')}>
                                <Input
                                    id="treatment-quarantine"
                                    inputMode="numeric"
                                    value={draft.quarantinePeriodDays}
                                    onChange={(e) => set('quarantinePeriodDays', e.target.value)}
                                />
                            </FormField>
                        </div>
                    </div>
                ) : step === 2 ? (
                    <div className="space-y-default">
                        <FormField label={t('crop')} required>
                            <Combobox
                                selected={cropOptions.find((o) => o.value === crop) ?? null}
                                setSelected={(o) => chooseCrop(o?.value ?? null)}
                                options={cropOptions}
                                placeholder={t('cropPlaceholder')}
                                searchPlaceholder={t('cropSearch')}
                                id="treatment-crop"
                            />
                        </FormField>

                        {crop ? (
                            <div className="grid gap-default lg:grid-cols-2">
                                <div
                                    className="max-h-80 space-y-tight overflow-y-auto"
                                    id="treatment-parcel-list"
                                >
                                    {parcelsLoading ? (
                                        <p className="text-content-muted">{t('parcelsLoading')}</p>
                                    ) : parcels.length === 0 ? (
                                        <p className="text-content-muted">{t('noParcels')}</p>
                                    ) : (
                                        parcels.map((p) => (
                                            <label
                                                key={p.id}
                                                className="flex items-center gap-compact"
                                            >
                                                <Checkbox
                                                    checked={selected.includes(p.id)}
                                                    onCheckedChange={(on) =>
                                                        setSelected((prev) =>
                                                            on
                                                                ? [...prev, p.id]
                                                                : prev.filter((id) => id !== p.id),
                                                        )
                                                    }
                                                />
                                                <span>
                                                    {p.name}
                                                    {/* The block, because two blocks can each
                                                        hold a field of the same name and the
                                                        block is the only thing telling them
                                                        apart to the person ticking boxes. */}
                                                    <span className="text-content-muted">
                                                        {' · '}
                                                        {p.locationName}
                                                    </span>
                                                </span>
                                            </label>
                                        ))
                                    )}
                                </div>
                                <div className="h-80">
                                    {/* Selection is shared both ways: the map is the
                                        established affordance here (`MapCanvas` owns
                                        `selectedIds`/`onSelectionChange`), so ticking a row
                                        highlights the field and tapping the field ticks the
                                        row. */}
                                    <MapCanvas
                                        parcels={mapParcels}
                                        selectedIds={selected}
                                        onSelectionChange={setSelected}
                                    />
                                </div>
                            </div>
                        ) : null}

                        {selected.length > 0 ? (
                            <p className="text-content-muted">
                                {t('selectedCount', { count: selected.length })}
                            </p>
                        ) : null}
                    </div>
                ) : (
                    <div className="space-y-section">
                        <p className="text-content-muted">{t('reviewIntro')}</p>

                        <dl className="rounded border border-border-subtle divide-y divide-border-subtle">
                            {reviewRows.map((row) => (
                                <div
                                    key={row.key}
                                    className="grid grid-cols-[11rem_1fr] gap-compact p-default"
                                >
                                    <dt className="text-content-muted">{row.label}</dt>
                                    <dd className="font-medium">{row.value}</dd>
                                </div>
                            ))}
                        </dl>

                        <div className="space-y-compact">
                            <p className="text-content-muted">
                                {t('selectedCount', { count: reviewParcels.length })}
                            </p>
                            <ul className="rounded border border-border-subtle divide-y divide-border-subtle">
                                {reviewParcels.map((parcel) => (
                                    <li
                                        key={parcel.id}
                                        className="flex items-baseline justify-between gap-compact p-default"
                                    >
                                        <span>{parcel.name}</span>
                                        {/* Shown only when the parcel row carries an
                                            area. `Parcel.areaHa` is nullable, and the
                                            register prints the parcel's own area when
                                            no treated area was given — so an absent
                                            value means "not recorded", which is not
                                            zero and must not render as one. */}
                                        {parcel.areaDca !== null ? (
                                            <span className="text-content-muted tabular-nums">
                                                {t('reviewArea', { dca: parcel.areaDca })}
                                            </span>
                                        ) : null}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </div>
                )}

                {error ? <p className="text-content-error">{error}</p> : null}

                <Modal.Footer>
                    {step > 1 ? (
                        <Button
                            variant="secondary"
                            type="button"
                            onClick={() => setStep(step === 3 ? 2 : 1)}
                        >
                            {t('back')}
                        </Button>
                    ) : null}
                    <Button variant="secondary" type="button" onClick={closeAndReset}>
                        {t('cancel')}
                    </Button>
                    <Button
                        variant="primary"
                        type="submit"
                        disabled={
                            submitting ||
                            // Step 3 has nothing of its own to satisfy: the
                            // step IS the confirmation, so Save is live on
                            // arrival. Step 2's condition still guards it,
                            // because reaching 3 requires passing 2.
                            (step === 1 ? !step1Complete : selected.length === 0)
                        }
                    >
                        {step === 3 ? t('save') : t('next')}
                    </Button>
                </Modal.Footer>
            </Modal.Form>
        </Modal>
    );
}
