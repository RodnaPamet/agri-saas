/**
 * Centralised step definitions for the Driver.js-based product
 * tour.
 *
 * Each step pairs a STABLE anchor (sidebar `data-testid` slug or
 * a documented page-level `#id`) with a concise body. The tour
 * code (`<OnboardingTour>`) is a thin wrapper that hands these
 * to driver.js's API — adding/editing/removing a step is a
 * one-place change.
 *
 * Stability rules:
 *   - Only target IDs / data-testids that already exist in the
 *     codebase and have a documented purpose. The discovery
 *     pass for this file enumerated them; never invent new
 *     anchors here without adding them to the page first.
 *   - Every step MUST be safe to skip. If the target element is
 *     not on the current page (e.g. the user opens a tour from
 *     a route that doesn't contain the anchor), the runner
 *     filters the step out before driver.js sees it.
 *   - Order is intentional — the tour walks the sidebar
 *     top-to-bottom, then closes with two productivity-tip
 *     steps (palette + theme toggle).
 *
 * Tone: short, present-tense, action-oriented. The audience is
 * a tenant operator on their first login — they have ~15
 * seconds of patience, not 5 minutes.
 *
 * This system is INTENTIONALLY separate from the existing
 * `<OnboardingWizard>` (tenant initial-setup wizard at
 * `src/components/onboarding/OnboardingWizard.tsx`), which is a
 * different concept (DB-backed multi-step config flow). The
 * structural ratchet at
 * `tests/unit/onboarding-tour-structural.test.ts` locks the
 * separation so future refactors can't conflate them.
 */

// ─── Public types ──────────────────────────────────────────────────────

export interface OnboardingStep {
    /** Stable id — used for analytics + per-step skip tracing. */
    id: string;
    /**
     * CSS selector for the highlighted element. `null` means the
     * step is centred ("welcome" / "tour complete" cards).
     */
    selector: string | null;
    /** Step heading rendered by driver.js's popover. */
    title: string;
    /** Body text — single sentence, plain text. */
    description: string;
    /**
     * Side of the target the popover should appear on.
     * Driver.js `Side`: 'top' | 'bottom' | 'left' | 'right'.
     * (driver.js 1.6.0 dropped the legacy 'over' value; no step used
     * it, so the union mirrors the library's current `Side` type.)
     */
    side?: 'top' | 'bottom' | 'left' | 'right';
}

// ─── Default tour ──────────────────────────────────────────────────────

/**
 * Single global tour set today. Future expansions (e.g. a
 * per-page "show me how" tour on /practices) plug in as
 * additional named exports without changing the runner.
 */
export const DEFAULT_TOUR_STEPS: ReadonlyArray<OnboardingStep> = [
    // Step 1 — welcome card. Centred (no anchor) so the user
    // sees the explainer regardless of the route they happened
    // to land on first.
    {
        id: 'welcome',
        selector: null,
        title: 'Welcome to your farm workspace',
        description:
            'A 30-second tour of the workspace. Use the arrow keys to navigate, or click Skip to dismiss for good.',
    },

    // Step 2 — Dashboard. The sidebar's data-testid slug pattern
    // is `nav-<href-tail>`; this anchor exists on every layout
    // that mounts <SidebarNav>.
    {
        id: 'sidebar.dashboard',
        selector: '[data-testid="nav-dashboard"]',
        title: 'Dashboard',
        description:
            'Your daily start point — today\'s field work, low stock, and recent activity at a glance.',
        side: 'right',
    },

    // ── Core ag steps (both personas; always present) ──

    // Step 3 — Journal.
    {
        id: 'sidebar.journal',
        selector: '[data-testid="nav-journal"]',
        title: 'Field Journal',
        description:
            'The daily logbook — record activities, observations, inputs, and harvests with photos and quantities.',
        side: 'right',
    },

    // Step 4 — Inventory.
    {
        id: 'sidebar.inventory',
        selector: '[data-testid="nav-inventory"]',
        title: 'Inventory',
        description:
            'Track seed, fertiliser, and pesticide stock by lot — spray jobs deduct automatically, harvests create new lots.',
        side: 'right',
    },

    // Step 5 — Farm Tasks.
    {
        id: 'sidebar.farm-tasks',
        selector: '[data-testid="nav-farm-tasks"]',
        title: 'Farm Tasks',
        description:
            'Assign field work to operators, tied to places and equipment — and see it on the calendar.',
        side: 'right',
    },

    // Step 6 — Knowledge.
    {
        id: 'sidebar.knowledge',
        selector: '[data-testid="nav-knowledge"]',
        title: 'Knowledge Base',
        description:
            'Versioned SOPs and growing guides your team reads and acknowledges.',
        side: 'right',
    },

    // ── Enterprise steps. These nav items only appear when the
    //    matching module is enabled, so `filterStepsForCurrentPage`
    //    drops them for a simple-mode (startup farmer) tenant — the
    //    tour adapts to the persona automatically, no branching. ──

    // Step 7 — Suppliers & buyers (enterprise only).
    {
        id: 'sidebar.vendors',
        selector: '[data-testid="nav-vendors"]',
        title: 'Suppliers & Buyers',
        description:
            'Your supplier and buyer register with assessments — appears when the Suppliers module is on.',
        side: 'right',
    },

    // Step 9 — Command palette tip. No DOM anchor (the palette is
    // a portal that only mounts on Cmd+K). Centred card with the
    // shortcut spelled out.
    {
        id: 'tip.command-palette',
        selector: null,
        title: 'Command palette',
        description:
            'Press ⌘K (or Ctrl+K) anywhere to search journal entries, inventory, tasks, and knowledge — or jump to any page.',
    },

    // Step 10 — final tour-complete card. Tells the user how to
    // restart, which is the single most common follow-up question.
    {
        id: 'tour-complete',
        selector: null,
        title: "You're set",
        description:
            'You can restart this tour any time from the "Take the tour" link in the sidebar footer.',
    },
];

// ─── Persona-aware step selection ─────────────────────────────────────

/**
 * The two product personas. `startup` is the simple-mode farmer (core ag
 * modules only); `enterprise` is the large producer / certified operation
 * (the full module surface, often inside an Organization of farms).
 */
export type OnboardingPersona = 'startup' | 'enterprise';

/** Step ids that are only meaningful for the enterprise persona. */
const ENTERPRISE_ONLY_STEP_IDS = new Set(['sidebar.practices', 'sidebar.vendors']);

/**
 * Curated step set for a persona. The runtime tour ALSO filters by anchor
 * presence (`filterStepsForCurrentPage`), so a startup farmer never sees a
 * certification step even via `DEFAULT_TOUR_STEPS` — this selector is the
 * explicit, analytics-friendly form (and lets a caller pre-trim before the
 * DOM exists, e.g. SSR or tests).
 */
export function getTourStepsForPersona(persona: OnboardingPersona): OnboardingStep[] {
    if (persona === 'enterprise') return [...DEFAULT_TOUR_STEPS];
    return DEFAULT_TOUR_STEPS.filter((s) => !ENTERPRISE_ONLY_STEP_IDS.has(s.id));
}

// ─── Persistence — completion / dismissal tracking ────────────────────

/**
 * localStorage key for the tour-completion flag. Per-user
 * persistence (the key includes the user id) so two operators
 * sharing a browser don't trigger the auto-tour for each other.
 */
export function tourCompletionKey(userId: string): string {
    return `inflect:onboarding-tour:completed:${userId}`;
}

/**
 * The completion blob is intentionally narrow — the only state
 * worth persisting is "the user has seen the tour at least once
 * and either finished or dismissed it." Anything richer (last
 * step viewed, total seconds spent) belongs in analytics, not
 * localStorage.
 */
export interface TourCompletionRecord {
    /** Schema version; lets us migrate without a hard reset. */
    version: 1;
    /** ms since epoch the user finished or dismissed. */
    at: number;
    /** Why the tour ended — `'finished'` (clicked Done) or `'skipped'`. */
    via: 'finished' | 'skipped';
}

export function makeCompletionRecord(via: TourCompletionRecord['via']): TourCompletionRecord {
    return { version: 1, at: Date.now(), via };
}

/**
 * Defensive load. Any non-conforming blob (older version,
 * tampered data, partial fields) reads as "not completed" so
 * the auto-trigger fires once and the user gets a clean run.
 */
export function isTourCompleted(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') return false;
    const v = raw as Partial<TourCompletionRecord>;
    if (v.version !== 1) return false;
    if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return false;
    if (v.via !== 'finished' && v.via !== 'skipped') return false;
    return true;
}

// ─── Filtering — drop steps whose anchor isn't on the page ────────────

/**
 * Returns the subset of steps whose `selector` exists in the
 * current document (or whose selector is null — "centred"
 * steps always run).
 *
 * Pure / DOM-aware — accepts a `findAnchor` resolver so the
 * helper unit-tests without a DOM. Production callers pass
 * `(s) => document.querySelector(s)`.
 */
export function filterStepsForCurrentPage(
    steps: ReadonlyArray<OnboardingStep>,
    findAnchor: (selector: string) => Element | null,
): OnboardingStep[] {
    return steps.filter((step) => {
        if (step.selector === null) return true;
        return findAnchor(step.selector) !== null;
    });
}

// ─── Guided first-run flow (feat/delight-onboarding) ────────────────────
//
// A brand-new farmer lands on a near-empty dashboard. This flow gives them
// two concrete next steps — "map your first field → log your first job" —
// surfaced as a dashboard progress ring that DISAPPEARS once the operation
// is set up. It is deliberately distinct from both the Driver.js product
// tour above (a sidebar walkthrough) and the DB-backed OnboardingWizard:
// the ring is a lightweight, data-derived nudge, not a config flow.
//
// Completion is DERIVED from real tenant data (see `firstRunProgress`),
// never a checkbox the user ticks — so the ring can't lie, and it vanishes
// the moment the underlying work is actually done.

/** The two first-run steps, also used as their completion-signal keys. */
export type FirstRunSignal = 'first-field-mapped' | 'first-job-logged';

export interface FirstRunStep {
    /** Stable id — doubles as the completion-signal key. */
    id: FirstRunSignal;
    /** Imperative step label ("Map your first field"). */
    label: string;
    /** One-line reason it matters. */
    hint: string;
    /** Tenant-relative path the CTA opens (joined with the tenant base). */
    href: string;
    /** CTA button label. */
    cta: string;
}

export const FIRST_RUN_STEPS: ReadonlyArray<FirstRunStep> = [
    {
        id: 'first-field-mapped',
        label: 'Map your first field',
        hint: 'Draw or import a parcel — every journal entry, job, and claim hangs off a location.',
        href: '/locations',
        cta: 'Map a field',
    },
    {
        id: 'first-job-logged',
        label: 'Log your first job',
        hint: 'Plan a field operation or log an activity — the field record behind every claim.',
        href: '/farm-tasks',
        cta: 'Plan a job',
    },
];

/**
 * Per-tenant localStorage key for dismissing the first-run card. Tenant-
 * scoped (not per-user) because "this farm is set up" is a tenant-level
 * fact — once any operator dismisses it, the farm is past onboarding.
 */
export function firstRunDismissKey(tenantId: string): string {
    return `inflect:onboarding-firstrun:dismissed:${tenantId}`;
}

/** Real-data signals the card reads from the existing `/dashboard/ag` payload. */
export interface FirstRunSignals {
    fieldMapped: boolean;
    jobLogged: boolean;
}

export interface FirstRunProgress {
    steps: ReadonlyArray<{ step: FirstRunStep; done: boolean }>;
    completedCount: number;
    total: number;
    allComplete: boolean;
}

/**
 * Derive first-run progress from real tenant signals. Pure — no storage,
 * no React, no fetch — so the card adds zero network cost (it reads the
 * payload the dashboard strip already loaded) and the logic unit-tests in
 * isolation.
 */
export function firstRunProgress(signals: FirstRunSignals): FirstRunProgress {
    const doneById: Record<FirstRunSignal, boolean> = {
        'first-field-mapped': signals.fieldMapped,
        'first-job-logged': signals.jobLogged,
    };
    const steps = FIRST_RUN_STEPS.map((step) => ({ step, done: doneById[step.id] }));
    const completedCount = steps.filter((s) => s.done).length;
    return {
        steps,
        completedCount,
        total: steps.length,
        allComplete: completedCount === steps.length,
    };
}
