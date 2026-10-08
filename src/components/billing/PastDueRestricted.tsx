/**
 * What a tenant sees instead of the exchange or trends once the PAST_DUE
 * grace has expired (#1325).
 *
 * ## Why this is a rendered state and NOT a redirect
 *
 * `requireModule` — the other page-level gate on these same surfaces —
 * redirects to the dashboard, and that is right for a module the tenant
 * chose to switch off: they know, because they did it. It is wrong here. The
 * owner's standing note on #1325 is that "degrading silently is worse than
 * not degrading", and a farmer who used Борса every morning and finds it
 * simply gone has been told nothing — the app reads as broken, and the one
 * action that fixes it is invisible.
 *
 * So the nav entry stays, the page explains itself, and the way to fix it is
 * one click away. The API is refused independently (`PAST_DUE_RESTRICTED`), so
 * this is not a UI-only gate: hiding the page without refusing the route would
 * leave the data reachable by any client that skipped the page.
 *
 * ## Why a LINK to billing rather than the portal button itself
 *
 * `BillingActions` is the Stripe portal button, and reusing it here was the
 * first draft. Two things are wrong with it:
 *
 *   * **It would 403 for most of the people who see this page.** The portal
 *     route is admin-gated, and an EDITOR or a MECHANISATOR is just as able to
 *     hit a restricted exchange as an OWNER. A button that fails for them is
 *     worse than no button — it reads as the app being broken on top of the
 *     restriction.
 *   * It lives under `src/app/t/[tenantSlug]/(app)/admin/billing/`, and
 *     importing it from here was the ONLY `src/components → src/app` import in
 *     the codebase. A dynamic segment in an import specifier, for a component
 *     every tenant route renders, is not a precedent worth setting for a
 *     button.
 *
 * The link is honest for every role: an admin lands on the page with the
 * portal button, and anybody else lands somewhere that names the problem and
 * can be shown to whoever pays the bill.
 */
import { getTranslations } from 'next-intl/server';

import { EmptyState } from '@/components/ui/empty-state';
import { PAST_DUE_GRACE_DAYS } from '@/lib/billing/past-due';

export async function PastDueRestricted({
    tenantSlug,
    /** Which surface they were trying to reach, for the description. */
    surface,
}: {
    tenantSlug: string;
    surface: 'exchange' | 'trends';
}) {
    const t = await getTranslations('billing.pastDue');

    return (
        <div className="p-default">
            <EmptyState
                variant="missing-prereqs"
                title={t('restrictedTitle')}
                description={t('restrictedBody', {
                    days: PAST_DUE_GRACE_DAYS,
                    surface: t(`surface.${surface}`),
                })}
                primaryAction={{
                    label: t('goToBilling'),
                    href: `/t/${tenantSlug}/admin/billing`,
                }}
            />
        </div>
    );
}
