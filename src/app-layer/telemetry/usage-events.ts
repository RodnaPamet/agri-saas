/**
 * The usage-event vocabulary — #493.
 *
 * Owner, 2026-11-01: *"our server, per account"*. Screen opens and key actions
 * go to `app.agrent.bg`, a superuser page shows them per farm and per screen,
 * and no third-party analytics is involved.
 *
 * ## Why a fixed server-side union and not free text
 *
 * This is the whole privacy design, not a tidiness preference. A `name` the
 * client may compose is a channel through which a record id, a crop, a parcel
 * or something a farmer typed WILL eventually arrive — not maliciously, but
 * because `track('treatment_saved:' + cropName)` is the obvious thing to write
 * when you want a breakdown. A closed union makes that impossible rather than
 * discouraged, and `NAME_SHAPE` below makes the rule checkable instead of
 * remembered.
 *
 * App Privacy declares this as Product Interaction / Analytics, **linked to the
 * user, not used for tracking**. Linked means it is personal data under GDPR,
 * which is why it has a 90-day life rather than living forever beside the
 * audit trail.
 */

/**
 * Where a `screen_opened` happened.
 *
 * The route-shaped values mirror iOS's `AppSurface` raw values; the three
 * without a leading slash are screens that are not routes. They are `surface`
 * VALUES rather than separate event names so the superuser page groups every
 * screen one way — a screen that is not a route is still a screen.
 */
export const USAGE_SURFACES = [
    '/journal',
    '/grain/calculator',
    '/exchange',
    '/locations',
    '/farm-tasks',
    '/trends',
    '/news',
    '/farm-risk',
    '/dashboard',
    '/notifications',
    '/documents',
    'mechanisator_home',
    'profile',
    'menu',
] as const;

export type UsageSurface = (typeof USAGE_SURFACES)[number];

/**
 * Every event this server will store. Anything else is DROPPED at ingest.
 *
 * Dropped, never refused: a shipped phone build must not break because a name
 * was retired here, and telemetry must never fail the app it measures. The
 * count of dropped names is logged so client drift is visible.
 */
export const USAGE_EVENT_NAMES = [
    // One name for every screen; the screen itself rides in `surface`.
    'screen_opened',

    // ── journal ──
    'treatment_saved',
    'activity_saved',
    'treatment_corrected',
    'treatment_deleted',
    'diary_pdf_downloaded',
    'farm_diary_downloaded',

    // ── costs ──
    'cost_saved',
    'cost_deleted',
    'invoice_scanned',

    // ── tasks ──
    'task_created',
    'task_closed',
    'task_comment_added',

    // ── documents ──
    'document_uploaded',
    'document_scanned',
    'drive_copy_requested',

    // ── exchange ──
    'listing_created',
    'listing_edited',
    // The two custody moves on «Моите обяви» (55.1). Added on the iOS peer's
    // request 2026-11-01, before any row existed — a rename after that needs a
    // migration, which is why the vocabulary is worth settling early.
    'listing_fulfilled',
    'listing_withdrawn',
    'inquiry_sent',
    'message_sent',

    // ── assistant ──
    'assistant_asked',
    'assistant_entry_opened',

    // ── misc ──
    'notification_opened',
    /**
     * The «you are here» parcel pre-tick in «Нов запис» was USED. The position
     * itself is never sent — owner's ruling is that location stays on the
     * phone — so this records that a convenience was taken, not where anybody
     * stood.
     */
    'parcel_located',
] as const;

export type UsageEventName = (typeof USAGE_EVENT_NAMES)[number];

/**
 * The shape every name must satisfy: lowercase snake_case, nothing else.
 *
 * It is exported so a guard can range over the union and fail on a name that
 * smuggles a value in — `treatment_saved_wheat` passes a human skim and is
 * exactly what this exists to catch. The guard asserts the shape AND that no
 * name contains a crop, a unit or an id-looking segment.
 */
export const NAME_SHAPE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/**
 * How long a usage event lives, in days.
 *
 * 90 days, and it is a SHARED constant because two things have to agree about
 * it: the sweep that deletes the rows, and the privacy notice that tells people
 * how long they are kept. Those drift silently, and the drift direction is
 * "the notice promises a shorter life than the data gets".
 *
 * Ninety rather than forever: this is Product Interaction data LINKED to the
 * user, so it is personal data under GDPR, and a retention period is the
 * difference between analytics and a permanent behavioural record. Ninety
 * rather than thirty: a season is the unit this product is used in, and a month
 * of data cannot answer whether a screen is used at sowing but not at harvest.
 */
export const USAGE_EVENT_RETENTION_DAYS = 90;

/** Upper bound on one batch. */
export const MAX_USAGE_EVENTS_PER_BATCH = 50;

/**
 * How far a client clock may be out before `at` is clamped to now.
 *
 * Clamped, not rejected: a phone that has been in a vehicle overnight, or one
 * whose user set the date by hand, still produces real usage — discarding it
 * would bias the data toward people with correct clocks. Nothing aggregates on
 * `at` anyway; `receivedAt` is the server's own and is what counts group by.
 */
export const MAX_CLIENT_CLOCK_SKEW_MS = 48 * 60 * 60 * 1000;

const NAMES = new Set<string>(USAGE_EVENT_NAMES);
const SURFACES = new Set<string>(USAGE_SURFACES);

export function isUsageEventName(v: unknown): v is UsageEventName {
    return typeof v === 'string' && NAMES.has(v);
}

export function isUsageSurface(v: unknown): v is UsageSurface {
    return typeof v === 'string' && SURFACES.has(v);
}
