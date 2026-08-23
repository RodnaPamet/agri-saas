'use client';

/**
 * InstallPrompt — the "Install Agrent" affordance for the operator PWA.
 *
 * Two paths, mobile-only:
 *   - Android/Chromium: capture the `beforeinstallprompt` event, suppress
 *     the mini-infobar, and show our own dismissible banner whose Install
 *     button replays the deferred prompt.
 *   - iOS Safari (no beforeinstallprompt): show an "Add to Home Screen"
 *     hint pointing at the Share-sheet, since that's the only install path.
 *
 * Dismiss snoozes for 7 days (localStorage). Hidden when already running
 * standalone (installed). Renders nothing on desktop.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useMediaQuery } from '@/components/ui/hooks';
import { isIos, isStandalone } from '@/lib/pwa/display-mode';

const SNOOZE_KEY = 'agri.install.snoozeUntil';
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isSnoozed(): boolean {
    try {
        const until = Number(globalThis.localStorage?.getItem(SNOOZE_KEY) ?? '0');
        return Number.isFinite(until) && until > Date.now();
    } catch {
        return false;
    }
}

export function InstallPrompt() {
    const t = useTranslations('installPrompt');
    const { isMobile } = useMediaQuery();
    const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
    const [iosHint, setIosHint] = useState(false);
    const [dismissed, setDismissed] = useState(false);

    useEffect(() => {
        if (isStandalone() || isSnoozed()) return;

        const onBeforeInstall = (e: Event) => {
            e.preventDefault(); // suppress the default mini-infobar
            setDeferred(e as BeforeInstallPromptEvent);
        };
        const onInstalled = () => {
            setDeferred(null);
            setIosHint(false);
        };
        window.addEventListener('beforeinstallprompt', onBeforeInstall);
        window.addEventListener('appinstalled', onInstalled);

        // iOS has no beforeinstallprompt — show the A2HS hint directly.
        if (isIos()) setIosHint(true);

        return () => {
            window.removeEventListener('beforeinstallprompt', onBeforeInstall);
            window.removeEventListener('appinstalled', onInstalled);
        };
    }, []);

    const snooze = useCallback(() => {
        try {
            globalThis.localStorage?.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
        } catch {
            /* private mode — just hide for this session */
        }
        setDismissed(true);
    }, []);

    const install = useCallback(async () => {
        if (!deferred) return;
        try {
            await deferred.prompt();
            await deferred.userChoice;
        } catch {
            /* user closed the native sheet — nothing to do */
        }
        setDeferred(null);
    }, [deferred]);

    // Suppressed under e2e/test mode — the install banner/hint is promotional
    // chrome (like the onboarding tour) that would otherwise overlay the
    // viewport (e.g. intercept the bottom-right FAB) and pollute mobile specs.
    // NEXT_PUBLIC_* must be read via process.env for build-time inlining.
    if (process.env.NEXT_PUBLIC_TEST_MODE === '1') return null;

    // Mobile-only; hidden once dismissed/installed.
    if (!isMobile || dismissed) return null;

    if (deferred) {
        return (
            <div
                data-testid="install-banner"
                role="dialog"
                aria-label={t('installTitle')}
                className="fixed inset-x-2 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.5rem)] z-40 flex items-center gap-default rounded-lg border border-border-default bg-bg-default p-3 md:hidden"
            >
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-content-emphasis">{t('installTitle')}</p>
                    <p className="text-xs text-content-secondary">{t('installDesc')}</p>
                </div>
                <Button variant="secondary" size="sm" onClick={snooze} data-testid="install-dismiss" aria-label={t('dismissPrompt')}>{t('notNow')}</Button>
                <Button variant="primary" size="sm" onClick={() => void install()} data-testid="install-accept">{t('install')}</Button>
            </div>
        );
    }

    if (iosHint) {
        return (
            <div
                data-testid="ios-install-hint"
                role="dialog"
                aria-label={t('a2hsAria')}
                className="fixed inset-x-2 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.5rem)] z-40 flex items-start gap-default rounded-lg border border-border-default bg-bg-default p-3 md:hidden"
            >
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-content-emphasis">{t('a2hsTitle')}</p>
                    <p className="text-xs text-content-secondary">
                        {t('a2hsDesc')}
                    </p>
                </div>
                <Button variant="secondary" size="sm" onClick={snooze} data-testid="install-dismiss" aria-label={t('dismissHint')}>{t('gotIt')}</Button>
            </div>
        );
    }

    return null;
}

export default InstallPrompt;
