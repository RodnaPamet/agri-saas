import { env } from '@/env';
import { TrendsPageClient } from '@/components/trends/TrendsPageClient';

/**
 * Trends page — market-price charts + an agri-news feed tab.
 *
 * A dashboard-style page visible to every tenant (market data is global, not
 * module-gated — same posture as Offers / Events). The Prices payload is fetched
 * client-side from `/api/t/<slug>/trends/prices`; the News feed from
 * `/api/t/<slug>/trends/news`. Both render an unconfigured/empty state when the
 * backend has no data. `newsConfigured` is computed server-side from
 * `MARKET_NEWS_FEEDS` (server-only — the URLs are never exposed to the client);
 * when unset the News tab shows an operator-configuration hint instead of a feed.
 * The client shell lives in `src/components/trends/` because it mounts the shared
 * tab primitive, which the `single-tab-pattern` guard forbids inside `src/app/**`.
 */
export default function TrendsPage() {
    const newsConfigured = !!env.MARKET_NEWS_FEEDS?.trim();
    return <TrendsPageClient newsConfigured={newsConfigured} />;
}
