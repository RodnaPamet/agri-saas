/**
 * Epic 62 — milestone celebration registry.
 *
 * The single source of truth for which farm milestones earn a confetti
 * moment, what preset fires, and which glyph rides the toast.
 *
 * ── the COPY is not here (P2.6) ──
 *
 * `message` / `description` used to be English literals on each record.
 * They are now `celebrations.<camelCaseKey>.{message,description}` in
 * `messages/{bg,en}.json`, resolved by `useCelebration()` — this module
 * is imported by a server usecase (`@/app-layer/usecases/achievements`
 * re-exports `AG_MILESTONE_ORDER`), so it cannot hold a translator, and
 * a lib-level literal is invisible to the hard-coded-string ratchet,
 * which only scans `src/app` + `src/components`. The hook owns an
 * EXHAUSTIVE `Record<MilestoneKey, …>` of those keys, so adding a
 * milestone without copy is a compile error rather than a toast
 * rendering a raw key path.
 *
 * `glyph` stays here on purpose: `messages/*.json` may contain no
 * decorative emoji (tests/guards/no-decorative-emoji-in-messages), and
 * an emoji is not copy — it does not change between locales.
 *
 * Adding a milestone:
 *   1. Add a literal to `MilestoneKey`.
 *   2. Add the matching record to `MILESTONES`.
 *   3. Add `celebrations.<camelCaseKey>.message` + `.description` to
 *      BOTH message catalogues, and the key to `MILESTONE_COPY` in
 *      `use-celebration.ts` (the Record makes this mandatory).
 *   4. (Optionally) wire a trigger from the page that detects it via
 *      `useCelebration()` from `@/components/ui/hooks`.
 *
 * Why a single registry instead of inline configs at each call site:
 *   - Product / docs can audit "what triggers a celebration" in one
 *     place without grepping for confetti calls.
 *   - The `MilestoneKey` literal union prevents typos at the call
 *     site (e.g. `celebrate('first_harvest')` won't compile).
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
 *                   (a whole season closed).
 */
export type CelebrationPreset = 'burst' | 'rain' | 'fireworks';

// ─── Milestone keys ─────────────────────────────────────────────────

/**
 * Stable identifiers for every supported milestone. Treat as PUBLIC
 * — these strings end up in `sessionStorage` keys and analytics
 * events, so renaming is a breaking change for in-flight sessions
 * and dashboards.
 */
// P2.6 dropped three GRC milestones — `framework-100`,
// `audit-pack-complete` and `first-practice-mapped`. Each described a
// model the GRC teardown deleted (Framework, AuditPack, Practice), no
// caller had fired one since, and their copy ("Audit pack ready",
// "Every applicable practice is implemented") was about to be
// translated into Bulgarian for farmers. `evidence-all-current`
// survives because the records page still fires it.
export type MilestoneKey =
    | 'evidence-all-current'
    // ─── Agriculture milestones (feat/delight-celebrations) ───
    | 'first-field-mapped'
    | 'spray-job-complete'
    | 'first-harvest'
    | 'season-closed';

// ─── Definition shape ──────────────────────────────────────────────

export interface MilestoneDefinition {
    /** Stable identifier — also the dedupe key in sessionStorage. */
    key: MilestoneKey;
    /** Confetti preset chosen to match the milestone's emotional weight. */
    preset: CelebrationPreset;
    /**
     * Emoji that trails the toast title. Locale-invariant, so it stays
     * out of `messages/*.json` (which bans decorative emoji) and the
     * hook appends it to the translated title.
     */
    glyph: string;
}

// ─── Registry ───────────────────────────────────────────────────────

export const MILESTONES: Record<MilestoneKey, MilestoneDefinition> = {
    'evidence-all-current': {
        key: 'evidence-all-current',
        preset: 'rain',
        glyph: '✨',
    },

    // ─── Agriculture milestones — meaningful events only, never routine saves ───
    'first-field-mapped': {
        key: 'first-field-mapped',
        preset: 'burst',
        glyph: '🗺️',
    },
    'spray-job-complete': {
        key: 'spray-job-complete',
        preset: 'burst',
        glyph: '🚜',
    },
    'first-harvest': {
        key: 'first-harvest',
        preset: 'burst',
        glyph: '🌾',
    },
    'season-closed': {
        key: 'season-closed',
        preset: 'fireworks',
        glyph: '🎉',
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
// GRC teardown phase 2 (plan §1c): `inspection-passed` and `sop-100-ack`
// were dropped with their data sources (AuditPack; Policy +
// PolicyAcknowledgement). Four genuinely agri milestones remain, and
// since P2.6 they are four of the FIVE milestones that exist at all.
export const AG_MILESTONE_ORDER: MilestoneKey[] = [
    'first-field-mapped',
    'spray-job-complete',
    'first-harvest',
    'season-closed',
];

// ─── Hook-input types (consumed by `useCelebration`) ───────────────
//
// They live here rather than in the hook file so a React-free caller
// can build one without pulling React imports back into this layer.

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

// ─── Per-resource scoping ──────────────────────────────────────────
//
// `scopedMilestone(key, scope)` used to live here: it combined a
// registered milestone with a per-resource scope so each framework /
// audit pack earned its own celebration in one session. Both of those
// resources went with the GRC teardown and the helper had zero
// production callers by P2.6, so it is gone rather than carried as a
// third input shape nobody uses.
//
// A future per-resource celebration passes the ad-hoc shape directly —
// `celebrate({ preset, key: `${milestone}:${resourceId}`, message })` —
// which is what the helper built. Keep the colon separator and a stable
// scope value (DB id, slug, route param) so a refresh keeps dedupe
// state consistent.
