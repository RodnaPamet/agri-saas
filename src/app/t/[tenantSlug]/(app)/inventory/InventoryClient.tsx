'use client';

import { useCallback, useMemo, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiGet, apiPost, apiPatch } from '@/lib/api-client';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { DataTable, createColumns } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Eyebrow, Heading } from '@/components/ui/typography';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { Fab } from '@/components/ui/fab';
import { PullToRefresh } from '@/components/ui/hooks';
import { ScrollToTop } from '@/components/ui/scroll-to-top';
import { Plus } from '@/components/ui/icons/nucleo';
import { StatusBadge } from '@/components/ui/status-badge';
import { Combobox } from '@/components/ui/combobox';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { DatePicker } from '@/components/ui/date-picker';
import { formatDate } from '@/lib/format-date';
import { QrCode } from '@/components/ui/qr-code';

interface Lot {
    id: string;
    lotCode: string;
    item: { id: string; name: string; category: string };
    unit: { id: string; symbol: string };
    location: { id: string; name: string } | null;
    quantityOnHand: number;
    expiresAt: string | null;
    lowStock: boolean;
}

interface LedgerRow {
    id: string;
    type: string;
    quantityDelta: number;
    unitSymbol: string;
    occurredAt: string;
    reason: string | null;
    actor: { id: string; name: string | null } | null;
}
interface LotDetail extends Omit<Lot, 'item'> {
    item: { id: string; name: string; category: string };
    ledger: LedgerRow[];
}

interface ItemRow {
    id: string;
    name: string;
    category: string;
    defaultUnit?: { symbol?: string };
}
interface UnitRow {
    id: string;
    name: string;
    symbol: string;
    measure: string;
}

// Lot-genealogy contract — GET /inventory/lots/{lotId}/trace.
interface TraceLotNode {
    id: string;
    lotCode: string;
    item: { id: string; name: string; category: string };
    unitSymbol: string;
    quantityOnHand: number;
    fields: { id: string; name: string }[];
}
interface TraceLotResult {
    root: TraceLotNode;
    ancestors: TraceLotNode[];
    descendants: TraceLotNode[];
    edges: { parentLotId: string; childLotId: string; type: string }[];
}

// Full editable item shape — GET /items/{itemId} (edit-product prefill).
interface ItemDetail {
    id: string;
    name: string;
    category: string;
    defaultUnitId: string;
    sku: string | null;
    reorderLevel: number | null;
    quarantinePeriodDays: number | null;
    activeIngredient: string | null;
    pppRegistrationNo: string | null;
}

// FLAG 5 — the inventory list/ledger endpoints return this envelope
// (`{ items, pageInfo }`), NOT the `{ rows, nextCursor }` shape the shared
// `useCursorPagination` hook consumes. The envelope is locked by an OpenAPI
// DTO + load tests, so we adapt on the client with the tiny accumulator
// below rather than reshaping the endpoint.
interface CursorPage<T> {
    items: T[];
    pageInfo: { nextCursor?: string | null; hasNextPage: boolean };
}

const CATEGORIES = ['SEED', 'PESTICIDE', 'FERTILIZER', 'AMENDMENT', 'FUEL', 'HARVESTED_PRODUCE', 'OTHER'] as const;

/**
 * Local cursor "load more" accumulator. `seed()` (re)sets page 1 — from an
 * SWR-owned first page (lot list, so create/movement `mutate()` reseeds it)
 * or a direct fetch (ledger). `loadMore()` fetches `buildPageUrl(cursor)`
 * and appends `items`, taking the next cursor + hasNextPage from `pageInfo`.
 * Mirrors `useCursorPagination`'s reseed/append contract for the `{ items,
 * pageInfo }` envelope.
 */
function useInventoryCursor<T>(buildPageUrl: (cursor: string) => string) {
    const [rows, setRows] = useState<T[]>([]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(false);

    const seed = useCallback((items: T[], cursor: string | null, more: boolean) => {
        setRows(items);
        setNextCursor(cursor);
        setHasMore(more);
        setLoading(false);
    }, []);

    const loadMore = useCallback(async () => {
        if (loading || !nextCursor) return;
        setLoading(true);
        try {
            const page = await apiGet<CursorPage<T>>(buildPageUrl(nextCursor));
            setRows((prev) => [...prev, ...page.items]);
            setNextCursor(page.pageInfo.nextCursor ?? null);
            setHasMore(page.pageInfo.hasNextPage);
        } catch {
            // Leave hasMore set so the operator can retry the same page.
        } finally {
            setLoading(false);
        }
    }, [loading, nextCursor, buildPageUrl]);

    return { rows, hasMore, loading, seed, loadMore };
}

export function InventoryClient({ tenantSlug }: { tenantSlug: string }) {
    const t = useTranslations('inventory');
    const buildUrl = useTenantApiUrl();
    // FLAG 5 — lot list: first page via SWR (so create-lot / movement
    // `mutate()` reseeds it), deeper pages via the local cursor accumulator.
    const { data: lotPage, mutate, isLoading } = useTenantSWR<CursorPage<Lot>>('/inventory/lots?limit=50');
    const buildLotPageUrl = useCallback(
        (cursor: string) => buildUrl(`/inventory/lots?limit=50&cursor=${encodeURIComponent(cursor)}`),
        [buildUrl],
    );
    const {
        rows: lotRows,
        hasMore: lotsHasMore,
        loading: lotsLoadingMore,
        seed: seedLots,
        loadMore: loadMoreLots,
    } = useInventoryCursor<Lot>(buildLotPageUrl);
    useEffect(() => {
        if (lotPage) seedLots(lotPage.items, lotPage.pageInfo.nextCursor ?? null, lotPage.pageInfo.hasNextPage);
    }, [lotPage, seedLots]);
    const { data: items, mutate: mutateItems } = useTenantSWR<ItemRow[]>('/items');
    // Units are a slow-changing catalog — relax SWR revalidation.
    const { data: units } = useTenantSWR<UnitRow[]>('/units', {
        revalidateOnFocus: false,
        dedupingInterval: 60_000,
    });

    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    // Product modal — dual-mode (create when editItemId is null, edit otherwise).
    const [showProduct, setShowProduct] = useState(false);
    const [editItemId, setEditItemId] = useState<string | null>(null);
    const [pName, setPName] = useState('');
    const [pCategory, setPCategory] = useState<string>('PESTICIDE');
    const [pUnitId, setPUnitId] = useState<string>('');
    // Low-stock reorder threshold (in the default unit) — drives the Low badge
    // + the daily reorder notification.
    const [pReorderLevel, setPReorderLevel] = useState('');
    // БАБХ farm-record — product regulatory fields.
    const [pQuarantineDays, setPQuarantineDays] = useState('');
    const [pActiveIngredient, setPActiveIngredient] = useState('');
    const [pPppRegNo, setPPppRegNo] = useState('');

    // New lot modal
    const [showLot, setShowLot] = useState(false);
    const [lItemId, setLItemId] = useState<string>('');
    const [lCode, setLCode] = useState('');
    const [lQty, setLQty] = useState('');
    const [lExpires, setLExpires] = useState<Date | null>(null);

    // Lot detail / movement modal
    const [activeLotId, setActiveLotId] = useState<string | null>(null);
    // Deep-link entry (QR codes on lots): `?lotId` opens that lot's detail
    // modal. Read once on mount.
    const searchParams = useSearchParams();
    useEffect(() => {
        const lotId = searchParams.get('lotId');
        if (lotId) setActiveLotId(lotId);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- deep-link read on mount only
    }, []);
    const { data: lotDetail, mutate: mutateLot } = useTenantSWR<LotDetail>(
        activeLotId ? `/inventory/lots/${activeLotId}` : null,
    );
    const [mvMode, setMvMode] = useState<'receive' | 'adjust'>('receive');
    const [mvQty, setMvQty] = useState('');
    const [mvReason, setMvReason] = useState('');

    // FLAG 5 — lot ledger: sourced entirely from the cursor `/ledger`
    // endpoint (the inline `lotDetail.ledger` first page carries no cursor,
    // so we fetch page 1 here and page forward with "Load more"). `lotDetail`
    // still drives the header on-hand.
    const buildLedgerPageUrl = useCallback(
        (cursor: string) =>
            buildUrl(`/inventory/lots/${activeLotId}/ledger?limit=50&cursor=${encodeURIComponent(cursor)}`),
        [buildUrl, activeLotId],
    );
    const {
        rows: ledgerRows,
        hasMore: ledgerHasMore,
        loading: ledgerLoadingMore,
        seed: seedLedger,
        loadMore: loadMoreLedger,
    } = useInventoryCursor<LedgerRow>(buildLedgerPageUrl);
    const refreshLedger = useCallback(
        async (lotId: string) => {
            try {
                const page = await apiGet<CursorPage<LedgerRow>>(
                    buildUrl(`/inventory/lots/${lotId}/ledger?limit=50`),
                );
                seedLedger(page.items, page.pageInfo.nextCursor ?? null, page.pageInfo.hasNextPage);
            } catch {
                seedLedger([], null, false);
            }
        },
        [buildUrl, seedLedger],
    );
    // Reset/refetch page 1 whenever the active lot changes. `activeLotId` is
    // the sole trigger — `refreshLedger` / `seedLedger` are stable (memoized
    // on a stable `buildUrl`), and listing them would re-run this effect on
    // any incidental identity churn of the URL builder, re-seeding an empty
    // page every render in a setState loop.
    useEffect(() => {
        if (!activeLotId) {
            seedLedger([], null, false);
            return;
        }
        void refreshLedger(activeLotId);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- activeLotId is the sole reactive trigger; refreshLedger/seedLedger are stable
    }, [activeLotId]);

    // Lot traceability (food-safety recall walk) — fetched lazily when the
    // operator opens the genealogy section for the active lot.
    const [showTrace, setShowTrace] = useState(false);
    const { data: trace, isLoading: traceLoading } = useTenantSWR<TraceLotResult>(
        showTrace && activeLotId ? `/inventory/lots/${activeLotId}/trace` : null,
    );

    // FLAG 6 — humanize raw enums for the UI. Static `t()` calls (no
    // dynamic template-literal keys) so next-intl's key typing holds; the
    // helpers fall back to the raw value for any unmapped enum member.
    const stockTypeLabels = useMemo<Record<string, string>>(
        () => ({
            RECEIPT: t('stockType.RECEIPT'),
            CONSUMPTION: t('stockType.CONSUMPTION'),
            HARVEST_IN: t('stockType.HARVEST_IN'),
            TRANSFER: t('stockType.TRANSFER'),
            ADJUSTMENT: t('stockType.ADJUSTMENT'),
            SALE_OUT: t('stockType.SALE_OUT'),
            DISPOSAL: t('stockType.DISPOSAL'),
        }),
        [t],
    );
    const categoryLabels = useMemo<Record<string, string>>(
        () => ({
            SEED: t('itemCategory.SEED'),
            PESTICIDE: t('itemCategory.PESTICIDE'),
            FERTILIZER: t('itemCategory.FERTILIZER'),
            AMENDMENT: t('itemCategory.AMENDMENT'),
            FUEL: t('itemCategory.FUEL'),
            HARVESTED_PRODUCE: t('itemCategory.HARVESTED_PRODUCE'),
            OTHER: t('itemCategory.OTHER'),
        }),
        [t],
    );
    const humanizeStockType = (type: string) => stockTypeLabels[type] ?? type;
    const humanizeCategory = (cat: string) => categoryLabels[cat] ?? cat;

    const itemOptions = useMemo(
        () => (items ?? []).map((i) => ({ label: `${i.name}`, value: i.id })),
        [items],
    );
    const unitOptions = useMemo(
        () => (units ?? []).map((u) => ({ label: `${u.name} (${u.symbol})`, value: u.id })),
        [units],
    );
    const categoryOptions = useMemo(
        () => CATEGORIES.map((c) => ({ label: humanizeCategory(c), value: c })),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- humanizeCategory closes over categoryLabels (memoized on t)
        [t],
    );

    const resetProductForm = () => {
        setEditItemId(null);
        setPName('');
        setPCategory('PESTICIDE');
        setPUnitId('');
        setPReorderLevel('');
        setPQuarantineDays('');
        setPActiveIngredient('');
        setPPppRegNo('');
    };

    const openNewProduct = () => {
        resetProductForm();
        setError(null);
        setShowProduct(true);
    };

    // Open the product modal in edit mode, pre-filled with the item's
    // current values (fetched from GET /items/{itemId}).
    const openEditProduct = async (itemId: string) => {
        setError(null);
        try {
            const item = await apiGet<ItemDetail>(buildUrl(`/items/${itemId}`));
            setEditItemId(item.id);
            setPName(item.name);
            setPCategory(item.category);
            setPUnitId(item.defaultUnitId);
            setPReorderLevel(item.reorderLevel != null ? String(item.reorderLevel) : '');
            setPQuarantineDays(item.quarantinePeriodDays != null ? String(item.quarantinePeriodDays) : '');
            setPActiveIngredient(item.activeIngredient ?? '');
            setPPppRegNo(item.pppRegistrationNo ?? '');
            setShowProduct(true);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load product');
        }
    };

    const submitProduct = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const payload = {
                name: pName,
                category: pCategory,
                defaultUnitId: pUnitId,
                reorderLevel: pReorderLevel.trim() ? Number(pReorderLevel) : null,
                quarantinePeriodDays: pQuarantineDays.trim() ? Number(pQuarantineDays) : null,
                activeIngredient: pActiveIngredient.trim() || null,
                pppRegistrationNo: pPppRegNo.trim() || null,
            };
            if (editItemId) {
                await apiPatch(buildUrl(`/items/${editItemId}`), payload);
            } else {
                await apiPost(buildUrl('/items'), payload);
            }
            setShowProduct(false);
            resetProductForm();
            await mutateItems();
            // On edit the item's name / reorder level feed the lots table, the
            // low-stock badge, and any open lot-detail header — refresh them.
            if (editItemId) await Promise.all([mutate(), lotDetail ? mutateLot() : Promise.resolve()]);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save product');
        } finally {
            setBusy(false);
        }
    };

    const createLot = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await apiPost(buildUrl('/inventory/lots'), {
                itemId: lItemId,
                lotCode: lCode,
                initialQuantity: lQty ? Number(lQty) : null,
                expiresAt: lExpires ? lExpires.toISOString() : null,
            });
            setShowLot(false);
            setLItemId('');
            setLCode('');
            setLQty('');
            setLExpires(null);
            await mutate();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create lot');
        } finally {
            setBusy(false);
        }
    };

    const postMovement = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!activeLotId) return;
        setBusy(true);
        setError(null);
        try {
            if (mvMode === 'receive') {
                await apiPost(buildUrl(`/inventory/lots/${activeLotId}/receive`), {
                    quantity: Number(mvQty),
                });
            } else {
                await apiPost(buildUrl(`/inventory/lots/${activeLotId}/adjust`), {
                    delta: Number(mvQty),
                    reason: mvReason,
                });
            }
            setMvQty('');
            setMvReason('');
            await Promise.all([mutate(), mutateLot()]);
            await refreshLedger(activeLotId);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to post movement');
        } finally {
            setBusy(false);
        }
    };

    const columns = useMemo(
        () =>
            createColumns<Lot>([
                {
                    accessorKey: 'lotCode',
                    header: t('colLot'),
                    cell: ({ row }) => <span className="font-medium">{row.original.lotCode}</span>,
                    // Mobile (<sm) card heading.
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    id: 'product',
                    header: t('colProduct'),
                    cell: ({ row }) => row.original.item.name,
                    // Mobile card secondary line — the product the lot is a batch of.
                    meta: { mobileCard: { slot: 'subtitle' } },
                },
                {
                    id: 'onHand',
                    header: t('colOnHand'),
                    cell: ({ row }) => (
                        <span className="flex items-center gap-tight">
                            {row.original.quantityOnHand} {row.original.unit.symbol}
                            {row.original.lowStock && <StatusBadge variant="warning">{t('low')}</StatusBadge>}
                        </span>
                    ),
                    // Mobile card key/value row — on-hand qty (carries the Low pill).
                    meta: { mobileCard: { slot: 'meta', label: t('colOnHand') } },
                },
                {
                    id: 'expires',
                    header: t('colExpires'),
                    cell: ({ row }) => (row.original.expiresAt ? formatDate(row.original.expiresAt) : '—'),
                    // Mobile card key/value row — expiry date.
                    meta: { mobileCard: { slot: 'meta', label: t('colExpires') } },
                },
                {
                    id: 'location',
                    header: t('colLocation'),
                    cell: ({ row }) => row.original.location?.name ?? '—',
                    // Mobile card key/value row — storage location.
                    meta: { mobileCard: { slot: 'meta', label: t('colLocation') } },
                },
            ]),
        [t],
    );

    const rows = lotRows;

    return (
        <ListPageShell className="gap-section">
            <ListPageShell.Header>
                <div className="flex items-center justify-between">
                    <div>
                        <PageBreadcrumbs
                            items={[{ label: t('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` }, { label: t('breadcrumbInventory') }]}
                            className="mb-1"
                        />
                        <Heading level={1}>{t('title')}</Heading>
                        <p className="text-sm text-content-secondary">{t('subtitle')}</p>
                    </div>
                    <div className="flex items-center gap-compact">
                        <Button variant="secondary" size="sm" onClick={openNewProduct}>{t('newProduct')}</Button>
                        <Button variant="primary" size="sm" onClick={() => setShowLot(true)} disabled={!items?.length}>{t('newLot')}</Button>
                    </div>
                </div>
            </ListPageShell.Header>
            <ListPageShell.Body>
                <DataTable
                    fillBody
                    mobileFallback="card"
                    data-testid="inventory-lots-table"
                    data={rows}
                    columns={columns}
                    loading={isLoading && !lotPage}
                    getRowId={(l) => l.id}
                    onRowClick={(l) => {
                        setActiveLotId(l.id);
                        setError(null);
                        setMvMode('receive');
                        setShowTrace(false);
                    }}
                    emptyState={
                        <EmptyState
                            size="sm"
                            variant="no-records"
                            title={t('emptyTitle')}
                            description={t('emptyDescription')}
                            primaryAction={{ label: t('newProduct'), onClick: openNewProduct }}
                        />
                    }
                />
            </ListPageShell.Body>
            <ListPageShell.Footer>
                {lotsHasMore && (
                    <div className="flex justify-center pt-default">
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void loadMoreLots()}
                            loading={lotsLoadingMore}
                        >
                            {t('loadMore')}
                        </Button>
                    </div>
                )}
            </ListPageShell.Footer>

            {/* Product — dual-mode (new / edit) */}
            <Modal
                showModal={showProduct}
                setShowModal={setShowProduct}
                size="md"
                title={editItemId ? t('editProductModalTitle') : t('productModalTitle')}
                description={t('productModalDescription')}
            >
                <Modal.Header
                    title={editItemId ? t('editProductModalTitle') : t('productModalTitle')}
                    description={editItemId ? t('editProductModalHeaderDescription') : t('productModalHeaderDescription')}
                />
                <Modal.Form id="new-product-form" onSubmit={submitProduct}>
                    <Modal.Body>
                        {error && showProduct && (
                            <div role="alert" className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error">{error}</div>
                        )}
                        <div className="space-y-default">
                            <FormField label={t('name')} required>
                                <Input value={pName} onChange={(e) => setPName(e.target.value)} placeholder={t('namePlaceholder')} />
                            </FormField>
                            <FormField label={t('category')} required>
                                <Combobox
                                    options={categoryOptions}
                                    selected={categoryOptions.find((o) => o.value === pCategory) ?? null}
                                    setSelected={(o) => setPCategory(o?.value ?? 'PESTICIDE')}
                                    placeholder={t('categoryPlaceholder')}
                                />
                            </FormField>
                            <FormField label={t('defaultUnit')} required>
                                <Combobox
                                    options={unitOptions}
                                    selected={unitOptions.find((o) => o.value === pUnitId) ?? null}
                                    setSelected={(o) => setPUnitId(o?.value ?? '')}
                                    placeholder={t('unitPlaceholder')}
                                />
                            </FormField>
                            <FormField label={t('reorderLevel')} hint={t('reorderLevelHint')}>
                                <Input
                                    inputMode="decimal"
                                    value={pReorderLevel}
                                    onChange={(e) =>
                                        setPReorderLevel(
                                            e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'),
                                        )
                                    }
                                    placeholder={t('reorderLevelPlaceholder')}
                                />
                            </FormField>
                            {/* БАБХ farm-record — regulatory fields (optional). */}
                            <FormField label={t('quarantineDays')} description={t('quarantineDaysHint')}>
                                <Input
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    value={pQuarantineDays}
                                    onChange={(e) =>
                                        setPQuarantineDays(e.target.value.replace(/[^0-9]/g, ''))
                                    }
                                    placeholder={t('quarantineDaysPlaceholder')}
                                />
                            </FormField>
                            <FormField label={t('activeIngredient')}>
                                <Input
                                    value={pActiveIngredient}
                                    onChange={(e) => setPActiveIngredient(e.target.value)}
                                    placeholder={t('activeIngredientPlaceholder')}
                                />
                            </FormField>
                            <FormField label={t('pppRegNo')}>
                                <Input
                                    value={pPppRegNo}
                                    onChange={(e) => setPPppRegNo(e.target.value)}
                                />
                            </FormField>
                        </div>
                    </Modal.Body>
                    <Modal.Actions>
                        <Button variant="secondary" size="sm" type="button" onClick={() => setShowProduct(false)}>{t('cancel')}</Button>
                        <Button variant="primary" size="sm" type="submit" loading={busy} disabled={!pName || !pUnitId || busy}>{editItemId ? t('saveProduct') : t('createProduct')}</Button>
                    </Modal.Actions>
                </Modal.Form>
            </Modal>

            {/* New lot */}
            <Modal
                showModal={showLot}
                setShowModal={setShowLot}
                size="md"
                title={t('lotModalTitle')}
                description={t('lotModalDescription')}
                isDirty={
                    lItemId.length > 0 ||
                    lCode.trim().length > 0 ||
                    lQty.trim().length > 0 ||
                    lExpires !== null
                }
            >
                <Modal.Header title={t('lotModalTitle')} description={t('lotModalHeaderDescription')} />
                <Modal.Form id="new-lot-form" onSubmit={createLot}>
                    <Modal.Body>
                        {error && showLot && (
                            <div role="alert" className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error">{error}</div>
                        )}
                        <div className="space-y-default">
                            <FormField label={t('product')} required>
                                <Combobox
                                    options={itemOptions}
                                    selected={itemOptions.find((o) => o.value === lItemId) ?? null}
                                    setSelected={(o) => setLItemId(o?.value ?? '')}
                                    placeholder={t('productPlaceholder')}
                                />
                            </FormField>
                            <FormField label={t('lotCode')} required>
                                <Input value={lCode} onChange={(e) => setLCode(e.target.value)} placeholder={t('lotCodePlaceholder')} />
                            </FormField>
                            <FormField label={t('initialQuantity')} hint={t('initialQuantityHint')}>
                                <Input inputMode="decimal" value={lQty} onChange={(e) => setLQty(e.target.value)} placeholder="0" />
                            </FormField>
                            <FormField label={t('expires')} hint={t('expiresHint')}>
                                <DatePicker value={lExpires} onChange={setLExpires} clearable placeholder={t('datePlaceholder')} />
                            </FormField>
                        </div>
                    </Modal.Body>
                    <Modal.Actions>
                        <Button variant="secondary" size="sm" type="button" onClick={() => setShowLot(false)}>{t('cancel')}</Button>
                        <Button variant="primary" size="sm" type="submit" loading={busy} disabled={!lItemId || !lCode || busy}>{t('createLot')}</Button>
                    </Modal.Actions>
                </Modal.Form>
            </Modal>

            {/* Lot detail + movement */}
            <Modal showModal={!!activeLotId} setShowModal={(v) => !v && setActiveLotId(null)} size="lg" title={t('lotTitle')} description={t('lotDescriptionTop')}>
                <Modal.Header
                    title={lotDetail ? `${lotDetail.item.name} — ${lotDetail.lotCode}` : t('lotTitle')}
                    description={lotDetail ? t('onHandLabel', { qty: lotDetail.quantityOnHand, unit: lotDetail.unit.symbol }) : undefined}
                />
                <Modal.Body>
                    {error && activeLotId && (
                        <div role="alert" className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error">{error}</div>
                    )}
                    {lotDetail && (
                        <div className="mb-default flex items-center justify-between gap-compact">
                            <span className="text-sm text-content-secondary">{lotDetail.item.name}</span>
                            <Button
                                variant="secondary"
                                size="sm"
                                type="button"
                                onClick={() => openEditProduct(lotDetail.item.id)}
                            >
                                {t('editProduct')}
                            </Button>
                        </div>
                    )}
                    {activeLotId && typeof window !== 'undefined' && (
                        <div className="mb-default flex items-center gap-default rounded-lg border border-border-subtle p-3">
                            <QrCode
                                value={`${window.location.origin}/t/${tenantSlug}/inventory?lotId=${activeLotId}`}
                                size={84}
                                title={t('qrTitle', { code: lotDetail?.lotCode ?? '' })}
                                className="shrink-0 rounded-md bg-white p-1"
                            />
                            <p className="text-xs text-content-secondary">
                                {t('qrHint')}
                            </p>
                        </div>
                    )}
                    <form id="movement-form" onSubmit={postMovement} className="space-y-default border-b border-border-subtle pb-default">
                        <ToggleGroup
                            ariaLabel={t('movementTypeAria')}
                            options={[
                                { value: 'receive', label: t('receive') },
                                { value: 'adjust', label: t('adjust') },
                            ]}
                            selected={mvMode}
                            selectAction={(v) => setMvMode(v as 'receive' | 'adjust')}
                        />
                        <div className="flex items-end gap-compact">
                            <FormField label={mvMode === 'receive' ? t('quantityIn') : t('signedDelta')} className="flex-1">
                                <Input inputMode="decimal" value={mvQty} onChange={(e) => setMvQty(e.target.value)} placeholder={mvMode === 'receive' ? '0' : t('deltaPlaceholder')} />
                            </FormField>
                            <Button variant="primary" size="sm" type="submit" loading={busy} disabled={!mvQty || (mvMode === 'adjust' && !mvReason) || (mvMode === 'receive' && !(Number(mvQty) > 0)) || busy}>
                                {t('post')}
                            </Button>
                        </div>
                        {mvMode === 'adjust' && (
                            <FormField label={t('reason')} required>
                                <Input value={mvReason} onChange={(e) => setMvReason(e.target.value)} placeholder={t('reasonPlaceholder')} />
                            </FormField>
                        )}
                    </form>

                    <div className="mt-default">
                        <Heading level={3}>{t('ledger')}</Heading>
                        {ledgerRows.length ? (
                            <ul className="mt-2 space-y-tight text-sm">
                                {ledgerRows.map((entry) => (
                                    <li key={entry.id} className="flex items-center justify-between border-b border-border-subtle py-1.5">
                                        <span className="flex items-center gap-compact">
                                            <StatusBadge variant={entry.quantityDelta < 0 ? 'error' : 'success'}>{humanizeStockType(entry.type)}</StatusBadge>
                                            <span className="text-content-muted">{formatDate(entry.occurredAt)}</span>
                                            {entry.reason && <span className="text-content-subtle">· {entry.reason}</span>}
                                        </span>
                                        <span className={entry.quantityDelta < 0 ? 'text-content-error' : 'text-content-success'}>
                                            {entry.quantityDelta > 0 ? '+' : ''}
                                            {entry.quantityDelta} {entry.unitSymbol}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="mt-2 text-sm text-content-subtle">{t('movementsEmpty')}</p>
                        )}
                        {ledgerHasMore && (
                            <div className="mt-default flex justify-center">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    type="button"
                                    onClick={() => void loadMoreLedger()}
                                    loading={ledgerLoadingMore}
                                >
                                    {t('loadMore')}
                                </Button>
                            </div>
                        )}
                    </div>

                    {/* Traceability — lot genealogy both ways (recall query). */}
                    <div className="mt-default border-t border-border-subtle pt-default">
                        <div className="flex items-center justify-between">
                            <Heading level={3}>{t('traceability')}</Heading>
                            <Button
                                variant="secondary"
                                size="sm"
                                type="button"
                                onClick={() => setShowTrace((v) => !v)}
                                aria-expanded={showTrace}
                            >
                                {showTrace ? t('hideGenealogy') : t('showGenealogy')}
                            </Button>
                        </div>
                        {showTrace && (
                            <div className="mt-default">
                                {traceLoading && !trace ? (
                                    <p className="text-sm text-content-subtle">{t('loadingGenealogy')}</p>
                                ) : trace ? (
                                    trace.ancestors.length === 0 && trace.descendants.length === 0 ? (
                                        <p className="text-sm text-content-subtle">{t('genealogyEmpty')}</p>
                                    ) : (
                                        <div className="space-y-default">
                                            <TraceGroup title={t('derivedFrom')} tone="muted" nodes={trace.ancestors} />
                                            <TraceGroup title={t('thisLot')} tone="emphasis" nodes={[trace.root]} />
                                            <TraceGroup title={t('produced')} tone="muted" nodes={trace.descendants} />
                                        </div>
                                    )
                                ) : (
                                    <p className="text-sm text-content-subtle">{t('genealogyEmpty')}</p>
                                )}
                            </div>
                        )}
                    </div>
                </Modal.Body>
                <Modal.Actions>
                    <Button variant="secondary" size="sm" type="button" onClick={() => setActiveLotId(null)}>{t('close')}</Button>
                </Modal.Actions>
            </Modal>

            {/* Mobile-only FAB — the primary create action in the thumb zone
                (md:hidden; the header buttons are the desktop affordance).
                Opens the New product flow: a product is the foundational
                record (the empty state's primary action too — a lot can't
                exist without one). */}
            <PullToRefresh onRefresh={() => mutate()} />
            <ScrollToTop />
            <Fab
                onClick={openNewProduct}
                label={t('fabLabel')}
                icon={<Plus aria-hidden className="h-6 w-6" />}
            />
        </ListPageShell>
    );
}

/**
 * One genealogy group (Derived from / This lot / Produced) — renders each
 * lot node with its product, category, on-hand quantity, and the parcels it
 * touched. `tone="emphasis"` marks the root lot apart from up/downstream lots.
 */
function TraceGroup({
    title,
    tone,
    nodes,
}: {
    title: string;
    tone: 'muted' | 'emphasis';
    nodes: TraceLotNode[];
}) {
    const t = useTranslations('inventory');
    // FLAG 6 — own category label map (this sub-component has its own `t`).
    const categoryLabels = useMemo<Record<string, string>>(
        () => ({
            SEED: t('itemCategory.SEED'),
            PESTICIDE: t('itemCategory.PESTICIDE'),
            FERTILIZER: t('itemCategory.FERTILIZER'),
            AMENDMENT: t('itemCategory.AMENDMENT'),
            FUEL: t('itemCategory.FUEL'),
            HARVESTED_PRODUCE: t('itemCategory.HARVESTED_PRODUCE'),
            OTHER: t('itemCategory.OTHER'),
        }),
        [t],
    );
    const humanizeCategory = (cat: string) => categoryLabels[cat] ?? cat;
    return (
        <section className="space-y-tight">
            <Eyebrow>{title}</Eyebrow>
            {nodes.length === 0 ? (
                <p className="text-sm text-content-subtle">{t('groupNone')}</p>
            ) : (
                <ul className="space-y-tight">
                    {nodes.map((n) => (
                        <li
                            key={n.id}
                            className={`rounded-lg border px-3 py-2 ${tone === 'emphasis' ? 'border-border-emphasis bg-bg-muted' : 'border-border-subtle'}`}
                        >
                            <div className="flex items-center justify-between gap-compact">
                                <span className="flex items-center gap-compact">
                                    <span className="font-medium text-content-emphasis">{n.lotCode}</span>
                                    <StatusBadge variant="neutral">{humanizeCategory(n.item.category)}</StatusBadge>
                                </span>
                                <span className="text-sm text-content-muted">
                                    {n.quantityOnHand} {n.unitSymbol}
                                </span>
                            </div>
                            <p className="mt-1 text-sm text-content-secondary">{n.item.name}</p>
                            {n.fields.length > 0 && (
                                <p className="mt-1 text-xs text-content-subtle">
                                    {t('fields', { fields: n.fields.map((f) => f.name).join(', ') })}
                                </p>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
