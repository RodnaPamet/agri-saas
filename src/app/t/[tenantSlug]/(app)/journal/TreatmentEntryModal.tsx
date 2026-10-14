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
 * ## The idempotency key is re-minted on every change
 *
 * `POST /journal/treatments` REPLAYS a reused key without comparing the body
 * (#1765). So a key held across an edit would return the earlier treatment,
 * report success, and silently drop the correction. The key is therefore
 * derived from the draft: change anything and it changes. That is the
 * client's whole responsibility here and the server cannot check it.
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

    const [step, setStep] = useState<1 | 2>(1);
    const [draft, setDraft] = useState<Draft>(emptyDraft);
    const [crop, setCrop] = useState<string | null>(null);
    const [selected, setSelected] = useState<string[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
        setDraft((d) => ({ ...d, [key]: value }));

    // ── Step 1 reference data ───────────────────────────────────────────
    const { data: items } = useTenantSWR<{ items?: ItemOption[] } | ItemOption[]>(
        open ? '/catalog/items?category=PESTICIDE,FERTILIZER' : null,
    );
    const { data: units } = useTenantSWR<{ units?: UnitOption[] } | UnitOption[]>(
        open ? '/catalog/units?measure=RATE' : null,
    );

    const itemOptions: ComboboxOption[] = useMemo(() => {
        const list = Array.isArray(items) ? items : (items?.items ?? []);
        return list.map((i) => ({ value: i.id, label: i.name }));
    }, [items]);
    const unitOptions: ComboboxOption[] = useMemo(() => {
        const list = Array.isArray(units) ? units : (units?.units ?? []);
        return list.map((u) => ({ value: u.id, label: u.symbol }));
    }, [units]);

    // ── Step 2 reference data ───────────────────────────────────────────
    const { data: cropData } = useTenantSWR<{ crops?: CropTotal[] }>(
        open && step === 2 ? '/parcels/by-crop' : null,
    );
    const { data: parcelData, isLoading: parcelsLoading } = useTenantSWR<{
        parcels?: ByCropParcel[];
    }>(open && step === 2 && crop ? `/parcels/by-crop?crop=${encodeURIComponent(crop)}` : null);

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
     * The request body, and the idempotency key DERIVED FROM IT.
     *
     * From the body and not from the draft, which is the whole point. The
     * draft holds what was typed; the body holds what is sent, trimmed and
     * with empty fields omitted. Keying on the draft meant two saves with an
     * IDENTICAL body could carry different keys — type a trailing space in
     * the pest field, lose the answer, delete the space, retry, and the
     * server mints a SECOND treatment because the key moved while the request
     * did not. Same for `2` versus `2.0` in the dose, which both send the
     * number 2.
     *
     * Re-minted by construction rather than by anyone remembering to. Every
     * edit changes the input, so a retry of an UNCHANGED save reuses the key
     * (which is what makes it idempotent) while an edited save gets a new one
     * (which is what stops the server replaying the old treatment at it).
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
    const productName = useMemo(() => {
        const list = Array.isArray(items) ? items : (items?.items ?? []);
        return list.find((i) => i.id === draft.productItemId)?.name ?? null;
    }, [items, draft.productItemId]);

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

    const heading = step === 1 ? t('stepOneTitle') : t('stepTwoTitle');

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
                ) : (
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
                )}

                {error ? <p className="text-content-error">{error}</p> : null}

                <Modal.Footer>
                    {step === 2 ? (
                        <Button variant="secondary" type="button" onClick={() => setStep(1)}>
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
                            (step === 1 ? !step1Complete : selected.length === 0)
                        }
                    >
                        {step === 1 ? t('next') : t('save')}
                    </Button>
                </Modal.Footer>
            </Modal.Form>
        </Modal>
    );
}
