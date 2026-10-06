import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { auth } from '@/auth';
import { Heading } from '@/components/ui/typography';

import { ChangePasswordForm } from './ChangePasswordForm';

export default async function AccountSecurityPage() {
    const session = await auth();
    if (!session?.user) redirect('/login?next=/account/security');

    const t = await getTranslations('account.security');

    return (
        <div className="w-full max-w-md">
            {/* P2.7: wrapper, background effects and the standalone shield
                lockup moved out when this page gained a shell. The shell owns
                the area <h1>; this steps down to level 2. */}
            <div className="mb-6">
                <Heading level={2}>{t('title')}</Heading>
            </div>

                <ChangePasswordForm />
        </div>
    );
}
