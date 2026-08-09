/**
 * Epic 62 — milestone celebration registry.
 *
 * The single source of truth for which compliance milestones earn a
 * confetti moment, what preset fires, and what toast accompanies it.
 *
 * Adding a milestone:
 *   1. Add a literal to `MilestoneKey`.
 *   2. Add the matching record to `MILESTONES`.
 *   3. (Optionally) wire a trigger from the page that detects it via
 *      `useCelebration()` from `@/components/ui/hooks`.
 *
 * Why a single registry instead of inline configs at each call site:
 *   - Product / docs can audit "what triggers a celebration" in one
 *     place without grepping for confetti calls.
 *   - The `MilestoneKey` literal union prevents typos at the call
 *     site (e.g. `celebrate('framework_100')` won't compile).
 *   - The `sessionStorage` dedupe key is derived from the milestone
 *     key, so two pages firing the same milestone in the same tab
 *     share dedupe state without coordinating.
 */

// ─── Presets ────────────────────────────────────────────────────────

/**
 * Visual style of the celebration. Each preset is a distinct
 * canvas-confetti choreography defined in
 * `src/components/ui/hooks/use-celebration.ts`.
 *
 *   - `burst`     — a single centred burst. Default for "you finished
 *                   a thing" milestones.
 *   - `rain`      — gentle particles falling across the top edge for a
 *                   couple of seconds. Best for "ongoing-good-state"
 *                   milestones (everything current).
 *   - `fireworks` — three offset bursts in succession, evoking a small
 *                   show. Reserve for high-stakes accomplishments
 *                   (audit pack frozen and shared).
 */
export type CelebrationPreset = 'burst' | 'rain' | 'fireworks';

// ─── Milestone keys ─────────────────────────────────────────────────

/**
 * Stable identifiers for every supported milestone. Treat as PUBLIC
 * — these strings end up in `sessionStorage` keys and analytics
 * events, so renaming is a breaking change for in-flight sessions
 * and dashboards.
 */
export type MilestoneKey =
    | 'framework-100'
    | 'evidence-all-current'
    | 'audit-pack-complete'
    | 'first-practice-mapped'
    // ─── Agriculture milestones (feat/delight-celebrations) ───
    | 'first-field-mapped'
    | 'spray-job-complete'
    | 'first-harvest'
    | 'season-closed'
    | 'inspection-passed'
    | 'sop-100-ack';

// ─── Definition shape ──────────────────────────────────────────────

export interface MilestoneDefinition {
    /** Stable identifier — also the dedupe key in sessionStorage. */
    key: MilestoneKey;
    /** Confetti preset chosen to match the milestone's emotional weight. */
    preset: CelebrationPreset;
    /** Toast title — short, present-tense ("Audit pack ready!"). */
    message: string;
    /** Optional toast description shown under `message`. */
    description?: string;
}

// ─── Registry ───────────────────────────────────────────────────────

export const MILESTONES: Record<MilestoneKey, MilestoneDefinition> = {
    'framework-100': {
        key: 'framework-100',
        preset: 'fireworks',
        message: '100% framework coverage 🎯',
        description: 'Every applicable practice is implemented.',
    },
    'evidence-all-current': {
        key: 'evidence-all-current',
        preset: 'rain',
        message: 'All evidence is current ✨',
        description: 'No evidence is overdue or expiring this week.',
    },
    'audit-pack-complete': {
        key: 'audit-pack-complete',
        preset: 'fireworks',
        message: 'Audit pack ready 📦',
        description: 'Frozen and shareable with your auditor.',
    },
    'first-practice-mapped': {
        key: 'first-practice-mapped',
        preset: 'burst',
        message: 'First practice mapped 🚀',
        description: "You're on your way — keep going.",
    },

    // ─── Agriculture milestones — meaningful events only, never routine saves ───
    'first-field-mapped': {
        key: 'first-field-mapped',
        preset: 'burst',
        message: 'First field on the map 🗺️',
        description: 'Your operation has its first mapped location.',
    },
    'spray-job-complete': {
        key: 'spray-job-complete',
        preset: 'burst',
        message: 'Spray job complete 🚜',
        description: 'Every parcel on the job is done.',
    },
    'first-harvest': {
        key: 'first-harvest',
        preset: 'burst',
        message: 'First harvest logged 🌾',
        description: 'The first crop is in the book.',
    },
    'season-closed': {
        key: 'season-closed',
        preset: 'fireworks',
        message: 'Season closed 🎉',
        description: 'A full season, start to finish — well done.',
    },
    'inspection-passed': {
        key: 'inspection-passed',
        preset: 'fireworks',
        message: 'Inspection passed 🏅',
        description: 'Your records stood up to the certifier.',
    },
    'sop-100-ack': {
        key: 'sop-100-ack',
        preset: 'rain',
        message: 'Every SOP acknowledged ✨',
        description: 'The whole team has read and signed off.',
    },
};

// ─── Dedupe-key derivation ─────────────────────────────────────────

/**
 * Namespaced sessionStorage key for a given milestone. Centralised so
 * callers (and tests) never spell the prefix inline.
 */
export function celebrationDedupeKey(key: string): string {
    return `inflect.celebrate:${key}`;
}

/**
 * Read-only helper — true when the milestone has already been
 * celebrated in this tab. SSR-safe (returns false on the server).
 *
 * Exposed so consumers can suppress secondary UI (a reactive "we
 * haven't congratulated you yet!" banner, say) without having to
 * call `celebrate()` and rely on the dedupe being a no-op.
 */
export function hasCelebrated(key: string): boolean {
    if (typeof window === 'undefined') return false;
    try {
        return window.sessionStorage.getItem(celebrationDedupeKey(key)) !== null;
    } catch {
        // Private mode / disabled storage — treat as "not yet" so the
        // first trigger still fires; the dedupe just won't persist
        // beyond the current call.
        return false;
    }
}

/**
 * Mark a milestone as celebrated in this tab. Idempotent. SSR-safe.
 * Exported separately so tests can prime the state without touching
 * sessionStorage internals directly.
 */
export function markCelebrated(key: string): void {
    if (typeof window === 'undefined') return;
    try {
        window.sessionStorage.setItem(
            celebrationDedupeKey(key),
            new Date().toISOString(),
        );
    } catch {
        // Same fallback rationale as `hasCelebrated`.
    }
}

/**
 * Clear the celebrated-state for a milestone. Used by tests and by
 * the (future) "reset onboarding" admin action so a returning user
 * can re-experience the burst.
 */
export function clearCelebrated(key: string): void {
    if (typeof window === 'undefined') return;
    try {
        window.sessionStorage.removeItem(celebrationDedupeKey(key));
    } catch {
        // Storage unavailable — nothing to clear.
    }
}

// ─── Achievement celebration dedupe (localStorage — fires once per browser) ─
//
// The ag achievements card fires a milestone celebration ONCE per browser; the
// per-tab `sessionStorage` helpers above would re-fire in every new tab. Raw
// localStorage is fine in this lib layer — the `src/app/**` localStorage ban
// (Epic 60) is about UI components reaching past the `useLocalStorage` hook,
// and that hook defers hydration (returns its initial value on first render),
// which a fire-once-on-mount check can't use. SSR-safe; fails soft.

const ACHIEVEMENTS_CELEBRATED_KEY = 'agri.achievements.celebrated.v1';

export function readCelebratedAchievements(): Set<string> {
    if (typeof window === 'undefined') return new Set();
    try {
        return new Set(JSON.parse(window.localStorage.getItem(ACHIEVEMENTS_CELEBRATED_KEY) ?? '[]') as string[]);
    } catch {
        return new Set();
    }
}

export function markAchievementsCelebrated(keys: string[]): void {
    if (typeof window === 'undefined') return;
    try {
        const current = readCelebratedAchievements();
        for (const k of keys) current.add(k);
        window.localStorage.setItem(ACHIEVEMENTS_CELEBRATED_KEY, JSON.stringify([...current]));
    } catch {
        /* private mode — celebration just isn't deduped persistently */
    }
}

// ─── Achievements (derived milestone state — CLIENT-SAFE) ──────────
//
// These live here (not in the achievements usecase) because the usecase
// imports prisma — a client component importing its VALUES (the order array)
// would drag prisma into the browser bundle. The usecase re-exports them.

export interface AchievementItem {
    key: MilestoneKey;
    earned: boolean;
    /** ISO timestamp the milestone was earned, when derivable. */
    earnedAt: string | null;
}

export interface JournalStreak {
    current: number;
    best: number;
}

export interface AchievementsResult {
    milestones: AchievementItem[];
    streak: JournalStreak;
}

/** The ag milestones surfaced on the achievements card, in display order. */
export const AG_MILESTONE_ORDER: MilestoneKey[] = [
    'first-field-mapped',
    'spray-job-complete',
    'first-harvest',
    'season-closed',
    'inspection-passed',
    'sop-100-ack',
];

// ─── Hook-input types (consumed by `useCelebration`) ───────────────
//
// Lifted out of the hook file so the pure-data builder
// (`scopedMilestone` below) can return them without pulling React
// imports back into this layer.

export interface CelebrateAdHocInput {
    preset: CelebrationPreset;
    /** Optional sessionStorage dedupe key. Omit to allow re-firing. */
    key?: string;
    /** Optional toast title. Skipped when omitted. */
    message?: string;
    /** Optional toast description shown under `message`. */
    description?: string;
}

export type CelebrateInput = MilestoneKey | CelebrateAdHocInput;

// ─── Per-resource milestone builder ────────────────────────────────

/**
 * Combine a registered milestone with a per-resource scope so each
 * resource (framework, audit pack, …) earns its own celebration in
 * the same session.
 *
 * Example — framework detail page:
 *
 *   celebrate(scopedMilestone('framework-100', frameworkKey, {
 *     descriptionOverride: `${frameworkName} — ${MILESTONES['framework-100'].description}`,
 *   }));
 *
 * Without a scope, all frameworks share the `framework-100` dedupe
 * key and only the first one to reach 100% celebrates per session.
 *
 * The scope is appended to the dedupe key with a colon separator —
 * `framework-100:iso27001`. Pick a stable scope value (DB id, slug,
 * route param) so refreshes keep dedupe state consistent.
 *
 * For milestones that are intrinsically tenant-wide (no scope makes
 * sense — `evidence-all-current`, `first-practice-mapped`), call
 * `celebrate('milestone-key')` directly instead of going through
 * this builder.
 */
export function scopedMilestone(
    key: MilestoneKey,
    scope: string,
    options: { descriptionOverride?: string } = {},
): CelebrateAdHocInput {
    const def = MILESTONES[key];
    return {
        preset: def.preset,
        key: `${key}:${scope}`,
        message: def.message,
        description: options.descriptionOverride ?? def.description,
    };
}
