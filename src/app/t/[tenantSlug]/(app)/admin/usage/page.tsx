import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { getTenantCtx } from '@/app-layer/context';
import { isPlatformTenant } from '@/lib/auth/platform-support';
import { getUsageInsights } from '@/app-layer/usecases/usage-insights';
import { USAGE_EVENT_RETENTION_DAYS } from '@/app-layer/telemetry/usage-events';
import { formatDateTime } from '@/lib/format-date';

/**
 * Platform-support console — «Използване», the #493 usage view.
 *
 * Owner, 2026-11-01: *"our server, per account"*, with a view per farm and per
 * screen. This is it.
 *
 * `notFound()` rather than a forbidden page, matching `admin/market-prices` and
 * `admin/promotions`: from any other tenant's perspective this console does not
 * exist, and an "access denied" screen would confirm there is a surface worth
 * going to look for — one that reports on every farm.
 *
 * ## It counts; it does not reconstruct
 *
 * Three aggregates and nothing else. No per-user timeline, no event list, no
 * way to ask what a named person did on Tuesday. The same table could answer
 * that question and this page deliberately cannot — `distinctUsers` is a COUNT,
 * never a list of ids. That restraint is the product decision, not an
 * incompleteness to be filled in later: a per-farm usage report is an
 * operational tool, and a per-person activity log is surveillance.
 *
 * ## A server component, reading directly
 *
 * No API route, because nothing else needs this data and an endpoint would be a
 * second surface to gate. The page is the consumer.
 */
export default async function UsageAdminPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<{ days?: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    if (!isPlatformTenant(tenantSlug) || !ctx.permissions.canAdmin) notFound();

    const { days: rawDays } = await searchParams;
    const t = await getTranslations('admin.usage');
    const insights = await getUsageInsights({ days: Number(rawDays ?? 30) });

    const empty = insights.totalEvents === 0;

    return (
        <div className="space-y-section">
            <header className="space-y-tight">
                <h1 className="text-xl font-[560] text-content-default">{t('title')}</h1>
                <p className="text-sm text-content-muted">
                    {t('subtitle', { days: insights.days })}
                </p>
                <p className="text-xs text-content-muted">
                    {t('windowNote', { retention: USAGE_EVENT_RETENTION_DAYS })}
                </p>
            </header>

            {empty ? (
                /*
                 * Two causes, one appearance, and they want different actions:
                 * the flag is off and nothing is being recorded, or the flag is
                 * on and nobody has used the product in this window. The page
                 * cannot tell them apart from a count alone, so it names BOTH
                 * rather than guessing — an "it's off" message on a live
                 * deployment would send an operator to flip a switch that is
                 * already flipped.
                 */
                <div className="rounded-md border border-border-subtle p-default text-sm text-content-muted space-y-tight">
                    <p>{t('noData')}</p>
                    <p>{t('flagOff')}</p>
                </div>
            ) : (
                <div className="space-y-section">
                    <p className="text-sm text-content-muted">
                        {t('totalEvents', { count: insights.totalEvents })}
                    </p>

                    <section className="space-y-default">
                        <h2 className="text-base font-[560] text-content-default">{t('byFarm')}</h2>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-border-subtle text-left text-content-muted">
                                        <th className="py-tight pr-default font-[560]">{t('colFarm')}</th>
                                        <th className="py-tight pr-default font-[560] tabular-nums">{t('colEvents')}</th>
                                        <th className="py-tight pr-default font-[560] tabular-nums">{t('colPeople')}</th>
                                        <th className="py-tight font-[560]">{t('colLastSeen')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {insights.byFarm.map((r) => (
                                        <tr key={r.tenantId} className="border-b border-border-subtle">
                                            <td className="py-tight pr-default">{r.tenantName}</td>
                                            <td className="py-tight pr-default tabular-nums">{r.events}</td>
                                            <td className="py-tight pr-default tabular-nums">{r.distinctUsers}</td>
                                            <td className="py-tight">{formatDateTime(r.lastSeen)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>

                    <section className="space-y-default">
                        <h2 className="text-base font-[560] text-content-default">{t('byScreen')}</h2>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-border-subtle text-left text-content-muted">
                                        <th className="py-tight pr-default font-[560]">{t('colScreen')}</th>
                                        <th className="py-tight pr-default font-[560] tabular-nums">{t('colEvents')}</th>
                                        <th className="py-tight font-[560] tabular-nums">{t('colPeople')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {insights.byScreen.map((r) => (
                                        <tr key={r.surface ?? r.name} className="border-b border-border-subtle">
                                            <td className="py-tight pr-default">{r.surface}</td>
                                            <td className="py-tight pr-default tabular-nums">{r.events}</td>
                                            <td className="py-tight tabular-nums">{r.distinctUsers}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>

                    <section className="space-y-default">
                        <h2 className="text-base font-[560] text-content-default">{t('byAction')}</h2>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-border-subtle text-left text-content-muted">
                                        <th className="py-tight pr-default font-[560]">{t('colAction')}</th>
                                        <th className="py-tight pr-default font-[560] tabular-nums">{t('colEvents')}</th>
                                        <th className="py-tight font-[560] tabular-nums">{t('colPeople')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {insights.byAction.map((r) => (
                                        <tr key={r.name} className="border-b border-border-subtle">
                                            {/*
                                             * The event NAME as stored. Deliberately not
                                             * translated: these are the 25 frozen vocabulary
                                             * values, the iOS enum uses the same strings, and
                                             * a superuser comparing this page with a client
                                             * bug report needs the literal token.
                                             */}
                                            <td className="py-tight pr-default font-mono text-xs">{r.name}</td>
                                            <td className="py-tight pr-default tabular-nums">{r.events}</td>
                                            <td className="py-tight tabular-nums">{r.distinctUsers}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>
                </div>
            )}
        </div>
    );
}
