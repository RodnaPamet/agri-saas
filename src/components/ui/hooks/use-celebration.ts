'use client';

/**
 * Epic 62 — `useCelebration` hook.
 *
 * Returns a stable `celebrate()` callback that fires a confetti
 * preset (and an optional toast) for a milestone, with per-tab
 * sessionStorage deduplication so a user who, say, refreshes the
 * dashboard three times doesn't get bombed three times.
 *
 * Two call shapes:
 *
 *   ```ts
 *   const { celebrate } = useCelebration();
 *
 *   // 1. By milestone key — pulls preset + toast from the registry
 *   //    in `src/lib/celebrations.ts`. Auto-deduped.
 *   celebrate('framework-100');
 *
 *   // 2. Ad-hoc — caller supplies preset + (optional) dedupe key.
 *   //    No toast unless `message` is provided.
 *   celebrate({ preset: 'burst', key: 'sandbox-demo', message: 'Nice!' });
 *   ```
 *
 * SSR safety: every browser-touching code path is guarded with
 * `typeof window === 'undefined'`. The returned `celebrate` is a
 * no-op on the server and inside test environments without a window.
 *
 * `prefers-reduced-motion`: every preset passes
 * `disableForReducedMotion: true` to canvas-confetti, which silently
 * suppresses the canvas when the user has opted out. The toast
 * still fires, so the user still gets the recognition without the
 * motion noise.
 *
 * ── where the milestone COPY lives (P2.6) ──
 *
 * `messages/{bg,en}.json` → `celebrations.<camelCaseKey>`, resolved
 * here. `MILESTONE_COPY` below is an EXHAUSTIVE
 * `Record<MilestoneKey, …>` of resolvers over that namespace, so a
 * milestone added to the registry without copy is a COMPILE error
 * rather than a toast rendering the literal string
 * `celebrations.whatever.message` (next-intl has no
 * `getMessageFallback` configured here — see
 * `tests/guards/i18n-key-exists.test.ts`). The keys are spelled as
 * static literals inside each resolver — a `t(`${x}.message`)` call is
 * a DYNAMIC key, which that guard skips by design, so a typo there
 * would reach a user with nothing failing.
 *
 * The emoji is NOT in the catalogue: `messages/*.json` bans decorative
 * emoji, and an emoji does not differ between locales. It rides
 * `MilestoneDefinition.glyph` and is appended to the translated title.
 *
 * The AD-HOC input shape still takes `message` / `description` as plain
 * strings — the caller supplies already-translated copy.
 */
// `'use client'` is load-bearing above: `useTranslations` is the CLIENT
// binding and next-intl resolves which implementation you get from the
// module's directive. `use-palette-commands.ts` is the precedent — the
// other `.ts` hook in this repo that calls it carries the same directive —
// and `tests/guards/i18n-use-client-directive.test.ts` cannot see either,
// because it walks `.tsx` only.
import { useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import {
    MILESTONES,
    type CelebrationPreset,
    type CelebrateAdHocInput,
    type CelebrateInput,
    type MilestoneDefinition,
    type MilestoneKey,
    hasCelebrated,
    markCelebrated,
} from '@/lib/celebrations';

/** A next-intl translator scoped to the `celebrations` namespace. */
type CelebrationTranslator = (key: string) => string;

/**
 * Milestone key → its translated toast copy.
 *
 * Exhaustive by type, and every i18n key is a STATIC literal so
 * `tests/guards/i18n-key-exists.test.ts` resolves all ten of them.
 */
export const MILESTONE_COPY: Record<
    MilestoneKey,
    (t: CelebrationTranslator) => { message: string; description: string }
> = {
    'evidence-all-current': (t) => ({
        message: t('evidenceAllCurrent.message'),
        description: t('evidenceAllCurrent.description'),
    }),
    'first-field-mapped': (t) => ({
        message: t('firstFieldMapped.message'),
        description: t('firstFieldMapped.description'),
    }),
    'spray-job-complete': (t) => ({
        message: t('sprayJobComplete.message'),
        description: t('sprayJobComplete.description'),
    }),
    'first-harvest': (t) => ({
        message: t('firstHarvest.message'),
        description: t('firstHarvest.description'),
    }),
    'season-closed': (t) => ({
        message: t('seasonClosed.message'),
        description: t('seasonClosed.description'),
    }),
};

// Re-exported here so the existing barrel keeps these public from
// the hooks namespace. Source of truth lives in `@/lib/celebrations`.
export type { CelebrateAdHocInput, CelebrateInput };

// ─── Types ──────────────────────────────────────────────────────────

export interface UseCelebrationResult {
    /**
     * Trigger a celebration. Pass a registered milestone key for the
     * default behaviour, or an ad-hoc `{ preset, ... }` object for
     * one-off effects (sandbox / demo).
     */
    celebrate: (input: CelebrateInput) => void;
    /** Pass-through to the registry's read-only dedupe check. */
    hasCelebrated: (key: string) => boolean;
}

// ─── Preset choreographies ─────────────────────────────────────────
//
// Each preset receives the canvas-confetti default export so the
// hook can stub it out in tests via DI without monkey-patching the
// module.

type ConfettiFn = (
    options?: import('canvas-confetti').Options,
) => Promise<null> | null;

const REDUCED_MOTION_DEFAULT = { disableForReducedMotion: true } as const;

function fireBurst(confetti: ConfettiFn): void {
    void confetti({
        ...REDUCED_MOTION_DEFAULT,
        particleCount: 120,
        spread: 70,
        origin: { x: 0.5, y: 0.6 },
        ticks: 200,
    });
}

function fireRain(confetti: ConfettiFn): void {
    // Three short bursts spread across the top, evenly spaced over
    // ~1.5 s. Reads as gentle "stuff falling" rather than a punch.
    [0.2, 0.5, 0.8].forEach((x, i) => {
        setTimeout(() => {
            void confetti({
                ...REDUCED_MOTION_DEFAULT,
                particleCount: 40,
                startVelocity: 25,
                spread: 60,
                gravity: 0.6,
                ticks: 300,
                origin: { x, y: 0 },
            });
        }, i * 500);
    });
}

function fireFireworks(confetti: ConfettiFn): void {
    // Three full-spread bursts staggered by ~250 ms from offset
    // origins — feels like a small show without dominating the page.
    [
        { x: 0.25, y: 0.5 },
        { x: 0.5, y: 0.45 },
        { x: 0.75, y: 0.5 },
    ].forEach((origin, i) => {
        setTimeout(() => {
            void confetti({
                ...REDUCED_MOTION_DEFAULT,
                particleCount: 80,
                startVelocity: 45,
                spread: 100,
                ticks: 250,
                origin,
            });
        }, i * 250);
    });
}

const PRESET_RUNNERS: Record<CelebrationPreset, (c: ConfettiFn) => void> = {
    burst: fireBurst,
    rain: fireRain,
    fireworks: fireFireworks,
};

// ─── Module-level cached confetti loader ────────────────────────────
//
// canvas-confetti pulls in a small canvas runtime; loading lazily on
// the first celebration keeps it out of the main bundle for users who
// never hit a milestone.

let cachedConfetti: ConfettiFn | null = null;

async function loadConfetti(): Promise<ConfettiFn> {
    if (cachedConfetti) return cachedConfetti;
    const mod = await import('canvas-confetti');
    cachedConfetti = mod.default as unknown as ConfettiFn;
    return cachedConfetti;
}

// Test-only seam — call this with a stub before invoking the hook to
// avoid pulling in the real library under jsdom. NOT exported via the
// barrel; tests reach in directly.
export function __setConfettiForTest(stub: ConfettiFn | null): void {
    cachedConfetti = stub;
}

// ─── Hook ───────────────────────────────────────────────────────────

export function useCelebration(): UseCelebrationResult {
    // Hold the latest cancellation-aware ref so unmounting between
    // the firing of the celebration and the toast settle doesn't
    // trip a setState-on-unmounted warning. Toast itself is fire-
    // and-forget; we just want a stable identity for the callback.
    const aliveRef = useRef(true);
    const t = useTranslations('celebrations');

    const celebrate = useCallback(
        (input: CelebrateInput) => {
            if (typeof window === 'undefined') return;

            // Resolve the call shape into (preset, dedupeKey, message,
            // description). Milestone-key path looks up the registry and
            // translates; ad-hoc path uses caller-supplied values.
            const resolved: {
                preset: CelebrationPreset;
                dedupeKey?: string;
                message?: string;
                description?: string;
            } = (() => {
                if (typeof input === 'string') {
                    const def: MilestoneDefinition = MILESTONES[input];
                    const copy = MILESTONE_COPY[input](t);
                    return {
                        preset: def.preset,
                        dedupeKey: def.key,
                        message: `${copy.message} ${def.glyph}`,
                        description: copy.description,
                    };
                }
                return {
                    preset: input.preset,
                    dedupeKey: input.key,
                    message: input.message,
                    description: input.description,
                };
            })();

            // Dedupe — only when a key was provided.
            if (resolved.dedupeKey && hasCelebrated(resolved.dedupeKey)) return;
            if (resolved.dedupeKey) markCelebrated(resolved.dedupeKey);

            // Fire confetti async (lazy import). Toast can fire
            // immediately so the message lands without waiting on the
            // chunk load.
            if (resolved.message) {
                toast.success(resolved.message, {
                    description: resolved.description,
                });
            }

            void loadConfetti().then((confetti) => {
                if (!aliveRef.current) return;
                PRESET_RUNNERS[resolved.preset](confetti);
            });
        },
        [t],
    );

    return { celebrate, hasCelebrated };
}
