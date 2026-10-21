'use client';

/**
 * «Цени» — the superuser daily price override (#1587 §5, the web half).
 *
 * ── What a number typed here does ───────────────────────────────────────
 *
 * Owner ruling 2026-10-10, confirmed directly 2026-10-20: a typed price
 * **always wins** over the API, on every surface and for every farm, until a
 * superuser clears it. The override publishes as `source: 'platform'` and
 * SUPPRESSES the feed for the reference price — so it moves
 * `getGrainNetWorth`, contracts and the headline figure everywhere, from one
 * field typed in this console.
 *
 * Three decisions in this file follow from that, and each is the kind that
 * looks like a nicety until it is the thing that saved a wrong number.
 *
 * ── 1. The inputs start EMPTY, never prefilled with the live value ──────
 *
 * The live typed price is shown beside each field as context, not in it. A
 * form prefilled with yesterday's numbers can be submitted whole by pressing
 * save, which would re-assert every one of them as TODAY's observation — ten
 * stale prices, all plausible, with an audit row saying a person entered them.
 * An empty field is simply not sent.
 *
 * ── 2. Only the rows actually filled are sent ───────────────────────────
 *
 * The POST takes one to ten. A day where the superuser knows wheat and barley
 * is a two-price day, not eight blanks to guess at.
 *
 * ── 3. The unit comes from the SERVER, every time ────────────────────────
 *
 * `entryUnit` is read from the response and rendered as the field's suffix.
 * This component holds no copy of the denomination table, deliberately: nine
 * commodities are `EUR/t` and diesel alone is `EUR/l`, so a client-side copy
 * that drifted would not produce an error — it would produce a diesel price
 * wrong by a factor of a thousand, rendered like any other.
 *
 * ── 4. Typed input is parsed STRICTLY, which `parseEuroPrice` is not ─────
 *
 * The obvious move was to reuse `parseEuroPrice` — the market domain already
 * owns "how a price string becomes a number". It is the wrong parser here, and
 * the rendered test is what established that: it strips everything that is not
 * a digit or separator, by design, because it reads feed strings like
 * `"€178,00"`. Pointed at a person's typing it turns `19o` into 19 and
 * `около 190` into 190 — a plausible number from a typo, which is this page's
 * worst outcome.
 *
 * A feed parser should be lenient; a human-entry field for a figure that moves
 * every farm's money should be strict. So `parseTypedPrice` refuses anything
 * that is not a bare number, and refuses MORE than three decimals' worth of
 * ambiguity: `1.950` is rejected rather than read as 1.95, because a person
 * typing a grain price almost certainly meant 1950 and the silent reading is
 * out by a factor of a thousand. Two decimals is not an arbitrary cap — it is
 * the precision the server stores at (`Math.round(price * 100) / 100`).
 *
 * A Bulgarian superuser types a comma; a native numeric input would discard it
 * outright, which is why this is a text field with a decimal keypad (and why
 * the repo's ratchet caps the alternative).
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cardVariants } from '@/components/ui/card';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { apiPost, apiDelete, ApiClientError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { PageHeader } from '@/components/layout/PageHeader';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { toYMD, parseYMD } from '@/components/ui/date-picker/date-utils';
import { SkeletonInput } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/hooks';
import { useDateFormat } from '@/lib/i18n/use-date-format';
import { farmToday } from '@/lib/calendar-day-key';
import { cn } from '@/lib/cn';

/** One row of the form read — `OverrideFormRow`, contract §5(c). */
interface OverrideRow {
    commodity: string;
    entryUnit: string;
    entryCurrency: string;
    typed: { value: number; currency: string; unit: string; date: string } | null;
    api: { value: number; currency: string; unit: string; date: string; source: string } | null;
    apiFeed: string;
}

/** A commodity with no feed anywhere: a typed price is its ONLY source. */
const NO_FEED = 'none';

/**
 * A bare number, with either separator and at most two decimals.
 *
 * Spaces are stripped first so `1 950` works — a thousands separator a person
 * reasonably types. Everything else must be digits and at most one separator:
 * `190`, `190,5`, `190.50`, `1 950` are accepted; `19o`, `около 190`,
 * `190 лв`, `1.950` and `1,950` are not. The last two are refused rather than
 * guessed — both readings are plausible and they differ by a thousandfold.
 */
const TYPED_PRICE = /^\d+(?:[.,]\d{1,2})?$/;

/** Parse a typed price strictly. Returns null for anything questionable. */
export function parseTypedPrice(raw: string): number | null {
    const compact = raw.replace(/[\s\u00a0\u202f]/g, '');
    if (!TYPED_PRICE.test(compact)) return null;
    const n = Number(compact.replace(',', '.'));
    return Number.isFinite(n) && n >= 0 ? n : null;
}

export function PriceOverridesClient() {
    const t = useTranslations('admin.marketPrices');
    const tCommodity = useTranslations('trends.commodities');
    const tc = useTranslations('common');
    const { formatDate } = useDateFormat();
    const buildUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const toast = useToast();

    const form = useTenantSWR<{ commodities: OverrideRow[] }>('/admin/market-prices/overrides');
    // Memoised on `form.data`, not spelled inline: `?? []` mints a new array
    // identity every render, which would change the deps of the `useMemo`
    // below on every render and make it a no-op that merely looks memoised.
    const rows = useMemo(() => form.data?.commodities ?? [], [form.data]);

    // Default to TODAY as the farm reckons it. `new Date().toISOString()` would
    // give the UTC day, so a price typed at 01:00 Sofia would be filed to
    // yesterday — `farmToday` is the repo's answer to exactly that.
    const [day, setDay] = useState<Date | null>(() => parseYMD(farmToday()));
    const [draft, setDraft] = useState<Record<string, string>>({});
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirmSave, setConfirmSave] = useState(false);
    const [clearTarget, setClearTarget] = useState<OverrideRow | null>(null);

    /**
     * What would be sent, and what cannot be.
     *
     * Computed together so the button's enabled state and the refusal message
     * can never disagree about which rows are filled.
     */
    const { entries, unreadable } = useMemo(() => {
        const ok: { commodity: string; value: number }[] = [];
        const bad: string[] = [];
        for (const row of rows) {
            const raw = (draft[row.commodity] ?? '').trim();
            if (raw === '') continue;
            const value = parseTypedPrice(raw);
            if (value === null) bad.push(row.commodity);
            else ok.push({ commodity: row.commodity, value });
        }
        return { entries: ok, unreadable: bad };
    }, [rows, draft]);

    const dayKey = toYMD(day);
    const canSave = dayKey !== null && entries.length > 0 && unreadable.length === 0 && !busy;

    /** Turn a coded refusal into copy a superuser can act on. */
    const describeRefusal = (err: unknown): string => {
        if (!(err instanceof ApiClientError)) return t('saveFailed');
        const details = (err.details ?? {}) as Record<string, unknown>;
        const commodity = typeof details.commodity === 'string' ? details.commodity : null;
        const name = commodity ? labelFor(commodity) : '';
        switch (err.code) {
            case 'DUPLICATE_COMMODITY':
                return t('errDuplicate', { commodity: name });
            case 'UNKNOWN_COMMODITY':
                return t('errUnknown', { commodity: name });
            case 'COMMODITY_NOT_OVERRIDABLE':
                return t('errNotOverridable', { commodity: name });
            case 'OVERRIDE_DENOMINATION_CHANGED':
                return t('errDenomination', {
                    commodity: name,
                    stored: String(details.stored ?? ''),
                    expected: String(details.expected ?? ''),
                });
            default:
                // A coded refusal carries a message the API wrote for a person.
                return err.message || t('saveFailed');
        }
    };

    /**
     * A commodity's display name, from `trends.commodities` rather than a
     * table of my own — the chart and this console must never disagree about
     * what «МАП» is called.
     */
    function labelFor(commodity: string): string {
        return tCommodity.has(commodity) ? tCommodity(commodity) : commodity;
    }

    const save = async () => {
        if (!canSave || dayKey === null) return;
        setBusy(true);
        setError(null);
        try {
            await apiPost(buildUrl('/admin/market-prices/overrides'), {
                date: dayKey,
                prices: entries,
            });
            toast.success(t('savedToast', { count: entries.length }));
            setDraft({});
            await form.mutate();
        } catch (err) {
            setError(describeRefusal(err));
        } finally {
            setBusy(false);
        }
    };

    const clear = async () => {
        const target = clearTarget;
        if (!target) return;
        setBusy(true);
        setError(null);
        try {
            await apiDelete(
                buildUrl(`/admin/market-prices/overrides/${encodeURIComponent(target.commodity)}`),
            );
            toast.success(t('clearedToast', { commodity: labelFor(target.commodity) }));
            await form.mutate();
        } catch (err) {
            setError(describeRefusal(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="space-y-section animate-fadeIn">
            {/*
             * `PageHeader` rather than a hand-rolled breadcrumbs + Heading +
             * <p> stack. The inline-subtitle budget caps that shape at 20
             * across src/app and names this component as its canonical home —
             * adding the 21st was how I found out.
             */}
            <PageHeader
                breadcrumbs={[
                    { label: t('breadcrumbAdmin'), href: tenantHref('/admin') },
                    { label: t('title') },
                ]}
                title={t('title')}
                description={t('description')}
            />

            {/*
             * Stated on the page, not only in a confirm dialog. The person
             * using this console is the only one who can see what a typed
             * price will do, and they see it once per visit here rather than
             * once per click.
             */}
            <InlineNotice variant="warning">{t('reach')}</InlineNotice>

            {error && <InlineNotice variant="error">{error}</InlineNotice>}

            <div className={cn(cardVariants(), 'space-y-default')}>
                <FormField label={t('dayLabel')} description={t('dayHint')}>
                    <DatePicker id="override-day" value={day} onChange={setDay} />
                </FormField>
            </div>

            <div className={cn(cardVariants(), 'space-y-default')}>
                <Heading level={2}>{t('pricesHeading')}</Heading>

                {form.isLoading && (
                    <div className="space-y-tight" data-testid="prices-loading">
                        <SkeletonInput />
                        <SkeletonInput />
                        <SkeletonInput />
                    </div>
                )}

                {!form.isLoading &&
                    rows.map((row) => {
                        const unreadableRow = unreadable.includes(row.commodity);
                        return (
                            <div
                                key={row.commodity}
                                className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-default md:items-end border-b border-[var(--border-subtle)] pb-default last:border-0 last:pb-0"
                            >
                                <FormField
                                    label={`${labelFor(row.commodity)} · ${row.entryUnit}`}
                                    description={
                                        row.typed
                                            ? t('liveTyped', {
                                                  value: row.typed.value,
                                                  unit: row.typed.unit,
                                                  date: formatDate(row.typed.date),
                                              })
                                            : row.api
                                              ? t('liveApi', {
                                                    value: row.api.value,
                                                    unit: row.api.unit,
                                                    date: formatDate(row.api.date),
                                                    source: row.api.source,
                                                })
                                              : row.apiFeed === NO_FEED
                                                ? t('feedAbsentHint')
                                                : t('priceAbsentHint')
                                    }
                                    error={unreadableRow ? t('notANumber') : undefined}
                                >
                                    <Input
                                        id={`price-${row.commodity}`}
                                        inputMode="decimal"
                                        placeholder={t('pricePlaceholder')}
                                        value={draft[row.commodity] ?? ''}
                                        onChange={(e) =>
                                            setDraft((d) => ({
                                                ...d,
                                                [row.commodity]: e.target.value,
                                            }))
                                        }
                                    />
                                </FormField>

                                <Button
                                    variant="ghost"
                                    disabled={!row.typed || busy}
                                    onClick={() => setClearTarget(row)}
                                >
                                    {t('clearAction')}
                                </Button>
                            </div>
                        );
                    })}
            </div>

            <div className="flex items-center justify-end gap-default">
                <span className="text-sm text-content-muted">
                    {t('willSend', { count: entries.length })}
                </span>
                <Button variant="primary" disabled={!canSave} onClick={() => setConfirmSave(true)}>
                    {t('saveDay')}
                </Button>
            </div>

            <ConfirmDialog
                showModal={confirmSave}
                setShowModal={setConfirmSave}
                tone="warning"
                title={t('confirmSaveTitle')}
                // The count AND the day, because the two mistakes this catches
                // are "I typed into the wrong row" and "I left the date on
                // yesterday" — and neither is visible from a generic prompt.
                description={t('confirmSaveBody', {
                    count: entries.length,
                    date: dayKey ? formatDate(dayKey) : '',
                })}
                confirmLabel={t('saveDay')}
                cancelLabel={tc('cancel')}
                onConfirm={save}
            />

            {/*
             * `warning`, not `danger`, and the distinction is the component's
             * own: danger means IRREVERSIBLE destructive (delete, revoke,
             * rotate). Clearing an override is neither. `clearedAt` MARKS the
             * series and its points rather than deleting them — #1587 §5(b)
             * requires that so the typed history and its audit trail survive
             * — and re-typing restores a price. It is a significant
             * consequence, which is exactly what `warning` is for.
             *
             * (`destructive-vocabulary` holds every `danger` dialog to a
             * canonical verb — Delete/Remove/Revoke/… — which «Изчисти» is
             * not. That guard is how I came to check the tone, but the tone
             * would be wrong at `danger` regardless of it.)
             */}
            <ConfirmDialog
                showModal={clearTarget !== null}
                /*
                 * The dialog owns a boolean; the page owns WHICH row. Mapping
                 * a close back to `setClearTarget(null)` keeps one source of
                 * truth — a separate `clearOpen` flag could disagree with the
                 * target and render a confirm naming the wrong commodity.
                 */
                setShowModal={(next) => {
                    const open =
                        typeof next === 'function' ? next(clearTarget !== null) : next;
                    if (!open) setClearTarget(null);
                }}
                tone="warning"
                title={t('confirmClearTitle')}
                /*
                 * Two different warnings, because clearing means two different
                 * things. For a commodity with a feed, authority returns to the
                 * feed. For one with NO feed anywhere — three of the ten — it
                 * leaves the calculator with no price at all, which will look
                 * like data loss unless it is said beforehand. The spec asks
                 * for this distinction explicitly.
                 */
                description={
                    clearTarget && clearTarget.apiFeed === NO_FEED
                        ? t('confirmClearNoFeed', {
                              commodity: labelFor(clearTarget.commodity),
                          })
                        : t('confirmClearBody', {
                              commodity: clearTarget ? labelFor(clearTarget.commodity) : '',
                          })
                }
                confirmLabel={t('clearAction')}
                cancelLabel={tc('cancel')}
                onConfirm={clear}
            />
        </div>
    );
}
