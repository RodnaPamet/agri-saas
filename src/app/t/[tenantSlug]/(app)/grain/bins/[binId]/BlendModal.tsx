'use client';

import { useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import { Combobox } from '@/components/ui/combobox';
import { Checkbox } from '@/components/ui/checkbox';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiPost } from '@/lib/api-client';
import { formatDecimal } from '@/lib/number-format';

interface BlendLot {
    id: string;
    lotCode: string;
    itemName: string;
    quantity: number;
    unitSymbol: string;
    attributes: Record<string, unknown> | null;
}

interface ItemRow {
    id: string;
    name: string;
    category: string;
}

interface Props {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    binId: string;
    binName: string;
    lots: BlendLot[];
    onBlended: () => void;
}

/** Quality keys the weighted preview covers — mirrors `blendQuality`. */
const QUALITY_KEYS = ['moisture', 'protein', 'testWeight'] as const;

/**
 * Quantity-weighted average, mirroring `blendQuality` in
 * `src/app-layer/usecases/grain-blend.ts` so the farmer sees the number the
 * server will store. The server remains authoritative — this is a preview,
 * and it deliberately does not try to reproduce the override precedence.
 */
function previewQuality(selected: BlendLot[]): Record<string, number> {
    const total = selected.reduce((s, l) => s + l.quantity, 0);
    if (total <= 0) return {};
    const out: Record<string, number> = {};
    for (const key of QUALITY_KEYS) {
        let weighted = 0;
        let covered = 0;
        for (const lot of selected) {
            const v = lot.attributes?.[key];
            if (typeof v === 'number') {
                weighted += v * lot.quantity;
                covered += lot.quantity;
            }
        }
        // Weight over the lots that actually carry the attribute, so one lot
        // missing a moisture reading doesn't silently drag the average down.
        if (covered > 0) out[key] = Math.round((weighted / covered) * 100) / 100;
    }
    return out;
}

/**
 * Blend/merge source lots in this bin into one output lot.
 *
 * `grain-blend.ts` has been ledger-safe, mass-conserving, atomic and
 * unit-strict since it was written — and had zero UI callers, which is why
 * three concurrency/validation defects in it stayed latent. This modal is the
 * entry point that makes it reachable, and it is deliberately the ONLY one:
 * the destination is always this bin.
 */
export function BlendModal({
    open,
    setOpen,
    binId,
    binName,
    lots,
    onBlended,
}: Props) {
    const t = useTranslations('grain.bins.blend');
    const buildUrl = useTenantApiUrl();

    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [outputItemId, setOutputItemId] = useState('');
    const [outputLotCode, setOutputLotCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const { data: items } = useTenantSWR<ItemRow[]>(open ? '/items' : null, {
        revalidateOnFocus: false,
    });

    // Blending produces grain, so only produce items can be the output. The
    // server also enforces that the output item's default unit matches the
    // sources' unit.
    const itemOptions = useMemo(
        () =>
            (items ?? [])
                .filter((i) => i.category === 'HARVESTED_PRODUCE')
                .map((i) => ({ value: i.id, label: i.name })),
        [items],
    );

    const selected = useMemo(
        () => lots.filter((l) => selectedIds.includes(l.id)),
        [lots, selectedIds],
    );
    const totalQuantity = selected.reduce((s, l) => s + l.quantity, 0);
    const preview = useMemo(() => previewQuality(selected), [selected]);

    // Mixed units cannot blend — the server rejects it, so say so here rather
    // than letting the farmer submit into a 400.
    const unitSymbols = [...new Set(selected.map((l) => l.unitSymbol))];
    const mixedUnits = unitSymbols.length > 1;

    const toggle = (id: string) => {
        setSelectedIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );
    };

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await apiPost(buildUrl('/grain/blend'), {
                // Whole lots: a partial-quantity blend is a different
                // operation, and the ledger records consumption either way.
                sourceLots: selected.map((l) => ({ lotId: l.id, quantity: l.quantity })),
                outputItemId,
                outputLotCode: outputLotCode.trim() || null,
                outputLocationId: binId,
            });
            setSelectedIds([]);
            setOutputItemId('');
            setOutputLotCode('');
            setOpen(false);
            onBlended();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to blend lots');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="lg"
            title={t('title')}
            description={t('description', { bin: binName })}
            isDirty={selectedIds.length > 0 || outputItemId.length > 0}
        >
            <Modal.Header title={t('title')} description={t('description', { bin: binName })} />
            <Modal.Form id="blend-form" onSubmit={submit}>
                <Modal.Body>
                    {error && (
                        <div
                            role="alert"
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                        >
                            {error}
                        </div>
                    )}
                    <div className="space-y-default">
                        <FormField label={t('sources')} hint={t('sourcesHint')} required>
                            <div className="space-y-tight rounded-lg border border-border-subtle p-3">
                                {lots.length === 0 && (
                                    <p className="text-sm text-content-subtle">{t('noLots')}</p>
                                )}
                                {lots.map((lot) => (
                                    <label
                                        key={lot.id}
                                        className="flex items-center gap-compact text-sm text-content-default"
                                    >
                                        <Checkbox
                                            checked={selectedIds.includes(lot.id)}
                                            onCheckedChange={() => toggle(lot.id)}
                                            aria-label={lot.lotCode}
                                        />
                                        <span className="flex-1">
                                            {`${lot.lotCode} — ${lot.itemName}`}
                                        </span>
                                        <span className="tabular-nums text-content-secondary">
                                            {`${formatDecimal(lot.quantity, 2)} ${lot.unitSymbol}`}
                                        </span>
                                    </label>
                                ))}
                            </div>
                        </FormField>

                        {selected.length > 0 && (
                            <div className="rounded-lg border border-border-subtle p-3 text-sm">
                                <p className="text-content-default">
                                    {t('totalPreview', {
                                        qty: formatDecimal(totalQuantity, 2),
                                        unit: unitSymbols[0] ?? '',
                                        count: selected.length,
                                    })}
                                </p>
                                {Object.keys(preview).length > 0 && (
                                    <p className="mt-1 text-content-secondary">
                                        {Object.entries(preview)
                                            .map(([k, v]) => `${t(`quality_${k}`)}: ${formatDecimal(v, 2)}`)
                                            .join(' · ')}
                                    </p>
                                )}
                                {mixedUnits && (
                                    <p className="mt-1 text-content-error">{t('mixedUnits')}</p>
                                )}
                            </div>
                        )}

                        <FormField label={t('outputItem')} required>
                            <Combobox
                                options={itemOptions}
                                selected={itemOptions.find((o) => o.value === outputItemId) ?? null}
                                setSelected={(o) => setOutputItemId(o?.value ?? '')}
                                placeholder={t('outputItemPlaceholder')}
                            />
                        </FormField>
                        <FormField label={t('outputLotCode')} hint={t('outputLotCodeHint')}>
                            <Input
                                value={outputLotCode}
                                onChange={(e) => setOutputLotCode(e.target.value)}
                                placeholder={t('outputLotCodePlaceholder')}
                            />
                        </FormField>
                    </div>
                </Modal.Body>
                <Modal.Actions>
                    <Button variant="secondary" size="sm" type="button" onClick={() => setOpen(false)}>
                        {t('cancel')}
                    </Button>
                    <Button
                        variant="primary"
                        size="sm"
                        type="submit"
                        loading={busy}
                        disabled={busy || selected.length === 0 || !outputItemId || mixedUnits}
                    >
                        {t('confirm')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
