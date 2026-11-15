import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { auth } from '@/auth';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { prisma } from '@/lib/prisma';
import { Heading } from '@/components/ui/typography';

import { AvatarUploadField } from './AvatarUploadField';
import { NameEditField } from './NameEditField';
import { FeedbackPrefsCard } from './FeedbackPrefsCard';
import { AssistantMemoryCard } from './AssistantMemoryCard';
import { AssistantConversationsCard } from './AssistantConversationsCard';
import { ChannelDigestCard } from './ChannelDigestCard';

/**
 * Account → Profile. Avatar roadmap P3 — the first home for the
 * avatar-image upload flow. A focused, standalone page in the same
 * shape as `/account/security`.
 */
export default async function AccountProfilePage() {
    const session = await auth();
    if (!session?.user) redirect('/login?next=/account/profile');

    const t = await getTranslations('account.profile');
    /*
     * Resolved on the SERVER and passed down — P5.3's rule. There is no
     * client-side flags hook in this codebase, and adding one would be a
     * second source of truth for a kill switch. Per PERSON, because the flag
     * resolves cohorts per user.
     */
    const memoryEnabled = await isFeatureEnabled('assistant.memory', session.user.id);
    /*
     * #2941 — the digest card is gated on `social.channels`, NOT on a flag of
     * its own. The digest is about channel activity, so a switch offered while
     * channels are off would promise a recap of a surface the person cannot
     * reach; and a separate flag could leave the control dark while the
     * feature needing it was live, which is P9.3's entry-point argument for
     * gating `PUT /api/social/profile` the same way.
     */
    const channelsEnabled = await isFeatureEnabled('social.channels', session.user.id);
    const digestOptIn = channelsEnabled
        ? ((await prisma.user.findUnique({
              where: { id: session.user.id },
              select: { channelDigestOptIn: true },
          }))?.channelDigestOptIn ?? false)
        : false;

    return (
        <div className="w-full max-w-md">
            {/* P2.7: the full-screen centred wrapper and its background
                effects moved out when this page gained a shell. The shell
                owns the <h1> for the area, so the section heading steps down
                to level 2 rather than competing with it. */}
            <div className="mb-6">
                <Heading level={2}>{t('pageTitle')}</Heading>
            </div>

                <AvatarUploadField
                    name={session.user.name ?? null}
                    email={session.user.email ?? null}
                    initialImage={session.user.image ?? null}
                />

                <NameEditField initialName={session.user.name ?? null} />

                <FeedbackPrefsCard />

                <AssistantMemoryCard enabled={memoryEnabled} />

                {/* The EXCHANGES half, below the conclusions drawn from them —
                    one screen, two controls, because deleting a conversation
                    and forgetting a point are different acts. */}
                <AssistantConversationsCard enabled={memoryEnabled} />

                {/* Renders NOTHING when channels are off, rather than a
                    disabled switch — P5.3's rule: a disabled control
                    advertises a feature that does not exist. */}
                {channelsEnabled && <ChannelDigestCard initialOptIn={digestOptIn} />}
        </div>
    );
}
