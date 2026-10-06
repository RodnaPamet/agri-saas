'use client';

/**
 * The account shell's section nav.
 *
 * A client component only because the active section comes from the pathname.
 * Everything else about this area is static, so the shell itself stays a server
 * component and this is the single island inside it.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';
import { CircleUser } from '@/components/ui/icons/nucleo/circle-user';
import { ShieldCheck } from '@/components/ui/icons/nucleo/shield-check';

const SECTIONS = [
    { href: '/account/profile', key: 'profile', Icon: CircleUser },
    { href: '/account/security', key: 'security', Icon: ShieldCheck },
] as const;

export function AccountNav() {
    const t = useTranslations('account.nav');
    const pathname = usePathname();

    return (
        <nav aria-label={t('label')} data-testid="account-nav" className="flex gap-1">
            {SECTIONS.map(({ href, key, Icon }) => {
                const active = pathname === href || pathname.startsWith(`${href}/`);
                return (
                    <Link
                        key={href}
                        href={href}
                        aria-current={active ? 'page' : undefined}
                        data-testid={`account-nav-${key}`}
                        data-active={active ? 'true' : 'false'}
                        className={cn(
                            // 44px minimum, as the phase requires of every
                            // touch target — this nav is the primary control
                            // on a phone, where the shell has no sidebar.
                            'inline-flex min-h-[44px] items-center gap-2 rounded-md px-3 text-sm font-medium',
                            'transition-colors duration-150',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                            active
                                ? 'bg-bg-subtle text-content-emphasis'
                                : 'text-content-muted hover:text-content-default hover:bg-bg-subtle/60',
                        )}
                    >
                        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span>{t(key)}</span>
                    </Link>
                );
            })}
        </nav>
    );
}
