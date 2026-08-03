'use client';

/**
 * Trends page — client shell.
 *
 * A dashboard-style (NOT entity-list) two-tab page: "Prices" (fully built) and
 * "News" (placeholder mount point). Uses the shared `<TabSelect>` primitive for
 * the tab bar — housed here under `src/components/trends/` rather than the route
 * folder because the `single-tab-pattern` guard forbids `<TabSelect>` inside
 * `src/app/**`.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { TabSelect } from '@/components/ui/tab-select';
import { Heading } from '@/components/ui/typography';
import { PricesTab } from './PricesTab';
import { NewsTab } from './NewsTab';

type TrendsTab = 'prices' | 'news';

export function TrendsPageClient({
    newsConfigured = false,
}: {
    /** Server-computed: is MARKET_NEWS_FEEDS set? Drives the News unconfigured hint. */
    newsConfigured?: boolean;
}) {
    const t = useTranslations('trends');
    const [tab, setTab] = useState<TrendsTab>('prices');

    return (
        <div className="space-y-section">
            <div className="space-y-default">
                <Heading level={1} id="trends-title">
                    {t('title')}
                </Heading>
                <TabSelect<TrendsTab>
                    options={[
                        { id: 'prices', label: t('tabs.prices') },
                        { id: 'news', label: t('tabs.news') },
                    ]}
                    selected={tab}
                    onSelect={setTab}
                    ariaLabel={t('tabsAriaLabel')}
                    idPrefix="trends-tab-"
                />
            </div>

            {tab === 'prices' ? <PricesTab /> : <NewsTab newsConfigured={newsConfigured} />}
        </div>
    );
}
