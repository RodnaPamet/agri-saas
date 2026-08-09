'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { hasSeenCoachMark, markCoachMarkSeen } from '@/lib/coach-marks';
import { cn } from '@/lib/cn';

/**
 * CoachMark — a first-time-only hint anchored to a UI element.
 *
 * Wrap the element you want to point at; the bubble renders once per
 * browser (keyed by `id` via `@/lib/coach-marks`) and never again after
 * the user taps "Got it". The decision is made AFTER mount (`show` starts
 * false, an effect flips it on only for a first-timer) so there's no SSR
 * mismatch and no flash for returning users.
 *
 * No shadow / no entrance animation by design — keeps the bubble clear of
 * the shadow-discipline + motion-language ratchets, and a hint that simply
 * appears is inherently reduced-motion-safe.
 */

export type CoachMarkPlacement = 'top' | 'bottom' | 'left' | 'right';

interface CoachMarkProps {
    /** Stable id — the localStorage dedupe key (shown exactly once). */
    id: string;
    title: string;
    body: string;
    placement?: CoachMarkPlacement;
    children: ReactNode;
    /** Classes on the relative wrapper (e.g. to make it inline-block). */
    className?: string;
}

// Suppress the bubble under E2E (the show-once hint always shows on a fresh
// browser, and an on-map / on-trigger bubble intercepts the taps the mobile
// map + field-op specs make). Same flag + rationale as the PWA InstallPrompt
// and the calendar badge. The wrapped children still render — only the hint
// is withheld — so the practices under it stay clickable.
const SUPPRESS_IN_TEST = process.env.NEXT_PUBLIC_TEST_MODE === '1';

// Global kill-switch (temporary). The coach-mark bubble is an absolutely-
// positioned hint that overflows the viewport on mobile (e.g. the on-map
// "find your fields" hint runs off-screen). Until a mobile-safe positioning
// pass lands we suppress every coach-mark app-wide: the wrapped children
// still render — only the hint is withheld. Flip back to true to restore.
const COACH_MARKS_ENABLED = false;

const PLACEMENT_POS: Record<CoachMarkPlacement, string> = {
    top: 'bottom-full left-0 mb-2',
    bottom: 'top-full left-0 mt-2',
    left: 'right-full top-0 mr-2',
    right: 'left-full top-0 ml-2',
};

export function CoachMark({
    id,
    title,
    body,
    placement = 'bottom',
    children,
    className,
}: CoachMarkProps) {
    const t = useTranslations('ui');
    const [show, setShow] = useState(false);

    useEffect(() => {
        if (!COACH_MARKS_ENABLED || SUPPRESS_IN_TEST) return;
        if (!hasSeenCoachMark(id)) setShow(true);
    }, [id]);

    function dismiss() {
        markCoachMarkSeen(id);
        setShow(false);
    }

    return (
        <div className={cn('relative', className)}>
            {children}
            {show && (
                <div
                    role="dialog"
                    aria-label={title}
                    className={cn(
                        'absolute z-30 w-64 rounded-lg border border-border-default bg-bg-default p-default',
                        PLACEMENT_POS[placement],
                    )}
                >
                    <p className="text-sm font-semibold text-content-primary">{title}</p>
                    <p className="mt-1 text-xs text-content-secondary">{body}</p>
                    <div className="mt-default flex justify-end">
                        <Button variant="primary" size="sm" onClick={dismiss}>
                            {t('coachMark.gotIt')}
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
