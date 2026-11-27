import { getLocale, getTranslations } from 'next-intl/server';
import { getTenantCtx } from '@/app-layer/context';
import { getSoilGuide } from '@/app-layer/usecases/knowledge';
import { soilLanguage } from '@/lib/knowledge/soil-guide';
import { Heading, TextLink } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';

export const dynamic = 'force-dynamic';

/**
 * «Почва» — the soil section of the knowledge base (owner, 2026-11-26).
 *
 * A server component over the code module `@/lib/knowledge/soil-guide`, which
 * the phone and the assistant's `soil_guide` tool read too. One page with a
 * table of contents and an anchor per topic, like the satellite guide, but
 * with no fetch and no fallback: the content ships with the build, so there
 * is no state in which it is missing.
 *
 * Each topic lists its sources with a link to the full document, because
 * these are summaries — a farmer acting on a distance or a date should be able
 * to read the rule itself.
 */
export default async function SoilGuidePage({ params }: { params: Promise<{ tenantSlug: string }> }) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    const sections = getSoilGuide(ctx, soilLanguage(await getLocale()));
    const t = await getTranslations('soilGuide');
    const knowledgeHref = `/t/${encodeURIComponent(tenantSlug)}/knowledge`;

    return (
        <div className="mx-auto w-full max-w-3xl space-y-section px-4 py-6">
            <div className="space-y-default">
                <PageBreadcrumbs items={[{ label: t('breadcrumbParent'), href: knowledgeHref }, { label: t('title') }]} />
                <Heading level={1}>{t('title')}</Heading>
                <p className="max-w-prose text-content-muted">{t('intro')}</p>
                <p className="max-w-prose text-xs text-content-subtle">{t('disclaimer')}</p>
            </div>

            <nav aria-label={t('tocLabel')} className="rounded-lg border border-border-subtle bg-bg-muted p-4">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-content-subtle">{t('tocLabel')}</p>
                <ul className="space-y-tight">
                    {sections.map((s) => (
                        <li key={s.id}>
                            <TextLink tone="link" href={`#${s.id}`}>
                                {s.title}
                            </TextLink>
                        </li>
                    ))}
                </ul>
            </nav>

            <div className="space-y-section">
                {sections.map((s) => (
                    <section key={s.id} id={s.id} className="scroll-mt-24 space-y-default">
                        <Heading level={2}>{s.title}</Heading>
                        <p className="max-w-prose text-content-muted">{s.summary}</p>
                        <ul className="max-w-prose list-disc space-y-tight pl-5">
                            {s.points.map((point) => (
                                <li key={point}>{point}</li>
                            ))}
                        </ul>
                        <div className="space-y-tight">
                            <Heading level={3}>{t('sources')}</Heading>
                            <ul className="space-y-tight text-sm">
                                {s.sources.map((src) => (
                                    <li key={src.id}>
                                        <TextLink tone="link" href={src.url} target="_blank" rel="noopener noreferrer">
                                            {src.title}
                                        </TextLink>
                                        <span className="text-content-muted">
                                            {t('sourceMeta', { publisher: src.publisher, year: String(src.year) })}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </section>
                ))}
            </div>
        </div>
    );
}
