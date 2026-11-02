import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { auth } from '@/auth';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { Heading } from '@/components/ui/typography';

import { AvatarUploadField } from './AvatarUploadField';
import { NameEditField } from './NameEditField';
import { FeedbackPrefsCard } from './FeedbackPrefsCard';
import { AssistantMemoryCard } from './AssistantMemoryCard';

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
        </div>
    );
}
