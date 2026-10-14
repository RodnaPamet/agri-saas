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
import { apiPost } from '@/lib/api-client';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { MapCanvas, type MapParcel } from '@/components/ui/map/MapCanvas';
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

export interface TreatmentSaved {
    treatmentGroupId: string;
    parcelCount: number;
}

interface Props {
    open: boolean;
    setOpen: (next: boolean) => void;
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

export function TreatmentEntryModal({ open, setOpen, onSaved }: Props) {
    const t = useTranslations('journal.treatmentForm');
    const apiUrl = useTenantApiUrl();

    const [step, setStep] = useState<1 | 2>(1);
    const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
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
        setDraft(EMPTY_DRAFT);
        setCrop(null);
        setSelected([]);
        setError(null);
        setOpen(false);
    }, [setOpen]);

    const dirty =
        JSON.stringify(draft) !== JSON.stringify(EMPTY_DRAFT) || selected.length > 0;

    const step1Complete =
        draft.occurredOn !== '' &&
        draft.productItemId !== null &&
        draft.doseValue.trim() !== '' &&
        draft.doseUnitId !== null;

    /**
     * The idempotency key, DERIVED from the draft and the parcel set.
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
    const idempotencyKey = useMemo(
        () => `web:${JSON.stringify(draft)}:${[...selected].sort().join(',')}`,
        [draft, selected],
    );

    const submit = useCallback(async () => {
        if (submitting || selected.length === 0) return;
        setSubmitting(true);
        setError(null);
        try {
            const saved = await apiPost<TreatmentSaved>(
                apiUrl('/journal/treatments'),
                {
                    kind: draft.kind,
                    occurredOn: draft.occurredOn,
                    parcelIds: selected,
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
                },
                // `apiPost(url, body, schema?, init?)` — the header rides in
                // the FOURTH argument. The third is a Zod schema, and this
                // file passed the init THERE, so the header was never sent:
                // on this route a missing key means the server mints a UUID,
                // and a retry after a lost answer writes a second treatment.
                //
                // Worth being exact about why it survived, because the
                // obvious explanation is wrong. `tsc` DOES reject it —
                // `TS2353: 'headers' does not exist in type ZodType<…>`,
                // measured by putting the mistake back. Excess-property
                // checking applies to an object literal passed directly as
                // an argument; it is spreads that escape it. What hid the
                // error was a stale `tsconfig.tsbuildinfo` reporting 0
                // errors on a file that had 12 (#1829), found with a
                // deliberate `const __probe: number = 'x'` that also came
                // back clean.
                //
                // Deliberately a plain header rather than `outboxHeaders()`:
                // that helper exists so a queued write's first attempt and its
                // replays share one key, and this write is not an outbox
                // surface.
                undefined,
                { headers: { 'Idempotency-Key': idempotencyKey } },
            );
            onSaved(saved);
            closeAndReset();
        } catch (e) {
            // The server's message is already localised for every coded
            // refusal, so showing it beats a generic sentence — and the codes
            // this route can return are documented in its spec entry.
            setError(e instanceof Error ? e.message : t('saveFailed'));
        } finally {
            setSubmitting(false);
        }
    }, [apiUrl, closeAndReset, draft, idempotencyKey, onSaved, selected, submitting, t]);

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
