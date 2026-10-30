/**
 * The agro notifications arrive in the RECIPIENT's language (#2490).
 *
 * ## What this file is for, and why it is not a guard
 *
 * Until this change the three agro titles were English string literals and
 * the bodies were English template functions, so every bell row and every
 * Web Push on this surface reached a Bulgarian farmer in English — in a
 * product whose `User.uiLanguage` column defaults to `bg`. A guard asserting
 * "`translateFor` is called" would have been satisfied by a call that
 * resolved the wrong locale, or by one whose key is absent from the
 * catalogue (`translateFor` returns the KEY on a miss, so a typo ships
 * «notifications.agro.sprayWindow.title» as a push title and nothing
 * throws). So this EXECUTES the writer against the real catalogue and reads
 * the stored row.
 *
 * `notification.createMany` and the SSE publish are doubled; the i18n layer
 * deliberately is NOT — a mocked `translateFor` cannot report that a key is
 * missing, which is the half that fails silently.
 */
const publishFreshMock = jest.fn().mockResolvedValue(undefined);
jest.mock('@/app-layer/notifications/publish-fresh', () => ({
    publishFreshNotifications: (...args: unknown[]) => publishFreshMock(...args),
}));

import type { PrismaClient } from '@prisma/client';

import {
    AGRO_COPY_KEYS,
    createAgroSignalNotification,
    type AgroNotificationKind,
    type AgroNotificationTarget,
} from '@/app-layer/notifications/agro';
import { renderDiseaseReason, renderSprayReason } from '@/lib/agro/reason-label';
import {
    evaluateDiseaseRisk,
    type DiseaseDay,
    type DiseaseReasonCode,
    type SprayReasonCode,
} from '@/lib/agro/rules';
import { loadMessagesFor } from '@/lib/i18n/server-messages';
import { LOCALES } from '@/lib/i18n/locales';

const NOW = new Date('2026-06-15T09:00:00Z');

/**
 * Captures the row `createMany` was handed.
 *
 * Typed through `Pick<PrismaClient, 'notification'>` — the narrow surface
 * `createAgroSignalNotification` actually takes — via `as unknown as` rather
 * than `any`. The writer's parameter is deliberately narrow so a double needs
 * no cast to the whole client; `unknown` keeps that honest without adding an
 * `any` the lint ratchet would (rightly) charge for.
 */
type NotificationDouble = Pick<PrismaClient, 'notification'>;

function makeDb() {
    const createMany = jest.fn().mockResolvedValue({ count: 1 });
    const db = { notification: { createMany } } as unknown as NotificationDouble;
    return { db, createMany };
}

function target(over: Partial<AgroNotificationTarget> = {}): AgroNotificationTarget {
    return {
        tenantId: 'tenant-1',
        recipientUserId: 'user-1',
        locationId: 'loc-1',
        locationLabel: 'Хасково 3',
        tenantSlug: 'acme',
        locale: 'bg',
        ...over,
    };
}

async function rowFor(kind: AgroNotificationKind, over: Partial<AgroNotificationTarget> = {}) {
    const { db, createMany } = makeDb();
    await createAgroSignalNotification(db, kind, target(over), NOW);
    expect(createMany).toHaveBeenCalledTimes(1);
    return createMany.mock.calls[0][0].data[0] as { title: string; message: string };
}

describe('agro notifications are written in the recipient language', () => {
    beforeEach(() => jest.clearAllMocks());

    it('writes Bulgarian copy for a bg recipient', async () => {
        const row = await rowFor('SPRAY_WINDOW_WARNING');
        expect(row.title).toBe('Неподходящ прозорец за пръскане');
        expect(row.message).toBe('Условията днес в Хасково 3 са неподходящи за пръскане.');
    });

    it('writes English copy for an en recipient', async () => {
        const row = await rowFor('SPRAY_WINDOW_WARNING', { locale: 'en' });
        expect(row.title).toBe('Spray window unsuitable');
        expect(row.message).toBe("Today's conditions at Хасково 3 are unsuitable for spraying.");
    });

    it('uses the WITH-DETAIL body when a detail is supplied, and interpolates it', async () => {
        const detail = 'Вятър 25 км/ч надвишава границата за отнасяне от 20 км/ч';
        const row = await rowFor('SPRAY_WINDOW_WARNING', { detail });
        expect(row.message).toBe(`Условията днес в Хасково 3 са неподходящи за пръскане — ${detail}`);
    });

    it('treats a whitespace-only detail as absent rather than rendering a dangling dash', async () => {
        const row = await rowFor('SPRAY_WINDOW_WARNING', { detail: '   ' });
        expect(row.message).toBe('Условията днес в Хасково 3 са неподходящи за пръскане.');
        expect(row.message).not.toContain('—');
    });

    it.each(['DISEASE_RISK_RAISED', 'AGRO_COPILOT_READY'] as const)(
        'resolves every key for %s in both locales — no key leaks into the row',
        async (kind) => {
            for (const locale of LOCALES) {
                for (const detail of [null, 'подробност']) {
                    const row = await rowFor(kind, { locale, detail });
                    // A `translateFor` miss returns the KEY. That is the
                    // failure this assertion exists for: it ships
                    // «notifications.agro.…» as a push title, silently.
                    expect(row.title).not.toContain('notifications.agro');
                    expect(row.message).not.toContain('notifications.agro');
                    expect(row.title.trim()).not.toBe('');
                    expect(row.message).toContain('Хасково 3');
                    if (detail) expect(row.message).toContain(detail);
                }
            }
        },
    );
});

describe('the catalogue covers every key the COPY table names', () => {
    // DERIVED from the table, not a hand-written list: a fourth
    // AgroNotificationKind added without copy fails here rather than
    // shipping its key as a title.
    it.each(LOCALES)('%s carries all three keys for all three kinds', async (locale) => {
        const messages = await loadMessagesFor(locale);
        expect(messages).not.toBeNull();
        const keys = AGRO_COPY_KEYS;
        expect(keys.length).toBe(9);
        console.log(`[agro-notification-locale] ${locale}: ${keys.length} copy keys checked`);
        for (const key of keys) {
            const value = key.split('.').reduce<unknown>(
                (node, part) =>
                    node && typeof node === 'object'
                        ? (node as Record<string, unknown>)[part]
                        : undefined,
                messages,
            );
            expect(typeof value).toBe('string');
            expect((value as string).trim()).not.toBe('');
        }
    });
});

describe('a reason renders as a sentence a person can read', () => {
    it('renders a spray reason with its params, per locale', async () => {
        const reason = { code: 'windUnsuitable', params: { wind: 25, limit: 20 } } as const;
        await expect(renderSprayReason('bg', reason)).resolves.toBe(
            'Вятър 25 км/ч надвишава границата за отнасяне от 20 км/ч',
        );
        await expect(renderSprayReason('en', reason)).resolves.toBe(
            'Wind 25 km/h exceeds the 20 km/h drift limit',
        );
    });

    it('renders a disease reason with its count AFTER a label (no ICU available)', async () => {
        const reason = { code: 'consecutiveWarmWetDays', params: { days: 4 } } as const;
        await expect(renderDiseaseReason('bg', reason)).resolves.toBe(
            'Топло-влажни дни подред: 4 — благоприятни за листни болести',
        );
        await expect(renderDiseaseReason('en', reason)).resolves.toBe(
            'Consecutive warm-wet days: 4 — favourable for foliar disease',
        );
    });

    it('answers null for an absent reason and for an uncatalogued code', async () => {
        await expect(renderSprayReason('bg', undefined)).resolves.toBeNull();
        // A code added to the union without copy must not put the KEY in
        // front of a farmer — `translateFor` returns the key on a miss.
        await expect(renderSprayReason('bg', { code: 'notACode' as unknown as SprayReasonCode, params: {} })).resolves.toBeNull();
        await expect(renderDiseaseReason('bg', { code: 'notACode' as unknown as DiseaseReasonCode, params: {} })).resolves.toBeNull();
    });
});

describe('evaluateDiseaseRisk emits codes beside its English sentences', () => {
    function day(offset: number, conducive: boolean): DiseaseDay {
        return {
            date: new Date(Date.UTC(2026, 5, 15 - offset)).toISOString().slice(0, 10),
            precipMm: conducive ? 6 : 0,
            humidityMean: conducive ? 93 : 40,
            tempMeanC: conducive ? 19 : 19,
        };
    }

    it('codes a quiet spell as noSustainedWarmWet', () => {
        const out = evaluateDiseaseRisk([3, 2, 1, 0].map((o) => day(o, false)));
        expect(out.level).toBe('LOW');
        expect(out.reasonCodes).toEqual([{ code: 'noSustainedWarmWet', params: {} }]);
        // The English sentence is UNCHANGED — the AI prompt and the audit
        // row still read it.
        expect(out.reasons).toEqual(['No sustained warm-wet period']);
    });

    it('codes a run with the day count the sentence quotes', () => {
        const out = evaluateDiseaseRisk([4, 3, 2, 1, 0].map((o) => day(o, true)));
        expect(out.level).toBe('HIGH');
        expect(out.reasonCodes).toEqual([
            { code: 'consecutiveWarmWetDays', params: { days: out.maxConsecutive } },
        ]);
        expect(out.maxConsecutive).toBe(5);
        expect(out.reasons[0]).toContain('5 consecutive warm-wet days');
    });
});
