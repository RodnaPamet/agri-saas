'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import {
    calendarSeason,
    timeOfDay,
    type CalendarSeason,
    type TimeOfDay,
} from '@/lib/season';
import type { HomeGreeting } from '@/app-layer/usecases/home-greeting';

/**
 * GreetingHeader — greets the farmer like a helpful colleague, in their
 * language, reflecting real weather + today's work.
 *
 * Time-of-day and calendar season are the USER's (browser timezone), so they
 * resolve AFTER mount — the SSR shell shows a neutral "Hello, {name}." that
 * swaps to "Good morning, {name}." once the client clock is read, avoiding a
 * hydration mismatch. Everything degrades gracefully: no name → no comma;
 * no farm signal at all → a warm welcome line.
 */

const SEASON_KEY: Record<CalendarSeason, 'seasonSpring' | 'seasonSummer' | 'seasonAutumn' | 'seasonWinter'> = {
    spring: 'seasonSpring',
    summer: 'seasonSummer',
    autumn: 'seasonAutumn',
    winter: 'seasonWinter',
};

function capitaliseFirst(s: string): string {
    return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

export function GreetingHeader({
    name,
    avatarUrl,
    data,
}: {
    name?: string | null;
    avatarUrl?: string | null;
    data: HomeGreeting;
}) {
    const t = useTranslations('dashboard.greeting');

    const [clock, setClock] = useState<{ tod: TimeOfDay; season: CalendarSeason } | null>(null);
    useEffect(() => {
        const now = new Date();
        setClock({ tod: timeOfDay(now.getHours()), season: calendarSeason(now.getMonth()) });
    }, []);

    const trimmedName = name?.trim() || null;
    const greetingWord = clock ? t(clock.tod) : t('hello');
    const greetingLine = trimmedName ? `${greetingWord}, ${trimmedName}.` : `${greetingWord}.`;

    // Build the status line from only the parts the data supports.
    const parts: string[] = [];
    if (data.fieldsGoodToSpray > 0) {
        const spray = t('sprayFields', { count: data.fieldsGoodToSpray });
        parts.push(
            data.representativeWindKmh != null
                ? `${spray} — ${t('sprayWind', { wind: data.representativeWindKmh })}`
                : spray,
        );
    }
    parts.push(data.tasksToday > 0 ? t('tasksToday', { count: data.tasksToday }) : t('noTasks'));

    const hasFarmSignal =
        data.fieldsGoodToSpray > 0 || data.fieldsWithWeather > 0 || data.tasksToday > 0;
    const statusLine = hasFarmSignal ? capitaliseFirst(parts.join(' · ')) : t('welcome');

    const seasonLabel = clock ? t(SEASON_KEY[clock.season]) : null;

    return (
        <Card density="comfortable" className="flex items-center gap-default">
            <InitialsAvatar
                value={trimmedName ?? ''}
                mode="name"
                size="md"
                imageUrl={avatarUrl ?? undefined}
                className="shrink-0"
            />
            <div className="min-w-0 flex-1 space-y-1">
                {seasonLabel && (
                    <p className="text-xs uppercase tracking-wide text-content-muted">{seasonLabel}</p>
                )}
                {/* The greeting is the dashboard's page title (the
                    "Compliance Dashboard" masthead header was removed in the
                    farm-UI trim), so it carries the page's sole level-1
                    heading. Visual size stays text-xl. */}
                <Heading level={1} className="text-xl">
                    {greetingLine}
                </Heading>
                <p className="text-sm text-content-muted">{statusLine}</p>
            </div>
        </Card>
    );
}

export default GreetingHeader;
