'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Heading } from '@/components/ui/typography';
import { Switch } from '@/components/ui/switch';
import { apiPut } from '@/lib/api-client';
import { useToast } from '@/components/ui/hooks';

/**
 * The opt-in 07:15 channel digest (#2941, P9.7 stage C).
 *
 * ## This card is the whole reason the feature is reachable
 *
 * `User.channelDigestOptIn` defaults to FALSE, so without a control nobody
 * can ever turn it on and the job would run every 15 minutes finding an empty
 * population for ever — green, silent, and indistinguishable from working.
 * That is #2844 (`/admin/public-profile` shipped linked from nowhere) and
 * P9.3's own entry-point rule: "a write with no reader", inverted.
 *
 * ## The initial value is PASSED IN, not fetched here
 *
 * `/api/account/channel-digest` has no GET, deliberately — the value rides
 * `/api/auth/me`, which the app already fetches at launch. So the server
 * component reads it and hands it down; a `useEffect` fetch here would be the
 * second round-trip that convention exists to avoid.
 *
 * ## It is OPTIMISTIC, and reverts on failure
 *
 * A switch that waits for a round-trip on rural LTE feels broken. It flips
 * immediately and flips BACK if the write fails, with a toast — rather than
 * staying flipped, which would tell the person they are opted in when the
 * column says otherwise. That is the same direction the composer takes: a
 * handler that swallows a failure loses what the operator asked for.
 */
export function ChannelDigestCard({ initialOptIn }: { initialOptIn: boolean }) {
    const t = useTranslations('account.channelDigest');
    const toast = useToast();
    const [optIn, setOptIn] = useState(initialOptIn);
    const [saving, setSaving] = useState(false);

    async function change(next: boolean): Promise<void> {
        setOptIn(next);
        setSaving(true);
        try {
            await apiPut('/api/account/channel-digest', { optIn: next });
        } catch {
            // Revert, because the column did not change. Leaving it flipped
            // would be the silent-success failure the route's schema exists
            // to prevent, reproduced on the client.
            setOptIn(!next);
            toast.error(t('saveFailed'));
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="mt-6 space-y-default rounded-lg border border-border-subtle bg-bg-default p-default">
            <div className="space-y-1">
                <Heading level={2} className="text-sm">
                    {t('title')}
                </Heading>
                <p className="text-xs text-content-muted">
                    {t('description')}
                </p>
            </div>
            <div className="flex items-center justify-between gap-default">
                <span className="text-sm text-content-default">{t('label')}</span>
                <Switch
                    checked={optIn}
                    disabled={saving}
                    onCheckedChange={change}
                    aria-label={t('labelAria')}
                />
            </div>
        </div>
    );
}

export default ChannelDigestCard;
