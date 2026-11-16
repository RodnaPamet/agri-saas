/**
 * Applying platform-admin corrections and additions to the published
 * calendar — #3095.
 *
 * ## Pure, and that is the seam
 *
 * The merge takes the overrides as an ARGUMENT rather than reading them. So
 * `calendarFor` stays a pure function of (dataset, query, overrides) and is
 * testable without a database, while the privileged read lives in the route
 * that already holds a request. It is the same arrangement as passing a Prisma
 * client in rather than importing one.
 *
 * ## `cites` and `basis` are MUTUALLY EXCLUSIVE, and that is the whole design
 *
 * The owner's rule is that a corrected window shows its basis INSTEAD of the
 * citation, never beside it. An override changes the VALUE while the published
 * citation still points at a page that no longer supports it — worse than an
 * uncited window, because it looks sourced.
 *
 * Sending both and documenting "do not render the citation" would make the
 * rule depend on every client obeying prose. Omitting `cites` from a corrected
 * window makes "beside" **unrepresentable**. The published original is not
 * lost: it moves to `supersedes`, a name that cannot be mistaken for a live
 * citation, so the admin console can show what МЗХ said beside what the
 * operator typed.
 *
 * ## `origin` is ABSENT on a published window, deliberately
 *
 * Absence means published, which the phone already implements. The point is
 * that a farm with no overrides receives **byte-identical** bytes to today:
 * nothing changes until a correction exists, and the route's ETag keeps
 * answering 304 for everyone else.
 *
 * ## What the phone does on builds that predate this
 *
 * Builds up to 160.1 drop any window with no citation, so a CORRECTED window
 * is simply absent there rather than shown with a stale citation — absent
 * beats wrong. The cost is real and recorded on #3095: correcting a window
 * farmers rely on takes it away from un-updated phones rather than showing
 * them the old value.
 */
import type { CalendarWindow } from './schema';
import { CalendarWindowSchema } from './schema';
import { z } from '@/lib/openapi/zod';

/**
 * The window an override carries: every published field EXCEPT the citation.
 *
 * Derived from `CalendarWindowSchema` by omission rather than retyped, so a
 * field added to a published window cannot be silently unavailable to a
 * correction — the two shapes stay in step by construction.
 */
export const OverrideWindowSchema = CalendarWindowSchema.omit({
    cite: true,
    alsoCite: true,
});
export type OverrideWindow = z.infer<typeof OverrideWindowSchema>;

export const OVERRIDE_ORIGINS = ['published', 'corrected', 'added'] as const;
export type OverrideOrigin = (typeof OVERRIDE_ORIGINS)[number];

/** A live override, as the merge needs it. */
export interface LiveOverride {
    readonly windowId: string;
    readonly cropKey: string;
    /** `published` is never stored — it is the absence of an override. */
    readonly origin: Exclude<OverrideOrigin, 'published'>;
    readonly window: OverrideWindow;
    readonly basis: { readonly bg: string; readonly en?: string };
}

/** What a corrected window replaced, for the admin console's benefit. */
export interface Superseded {
    readonly from: string;
    readonly to: string;
    readonly cites: readonly { readonly source: string; readonly page: number | string }[];
}

/**
 * The shape the merge needs to see. Generic rather than
 * `Record<string, unknown>`, so the caller's own window type flows through and
 * `load.ts` needs no cast — a cast there would remove the target a later
 * mistake could fail against.
 */
export interface MergeableWindow {
    id: string;
    region: string;
    from: string;
    to: string;
    cites?: { source: string; page: number | string }[];
    origin?: 'corrected' | 'added';
    basis?: { bg: string; en?: string };
    supersedes?: Superseded;
}

/**
 * Apply live overrides to one crop's served windows.
 *
 * Returns a NEW array; nothing is mutated, because the dataset is a
 * module-level constant shared by every request and a mutation would leak
 * across them.
 *
 * A CORRECTED override whose `windowId` matches no published window is
 * IGNORED rather than appended. It means the base dataset changed under a
 * correction — a window was renamed or removed — and appending it would
 * resurrect a window МЗХ no longer publishes, under a basis written about a
 * different one. `unmatchedCorrections` reports them so the console can show
 * an operator that their correction has stopped applying.
 */
export function applyOverrides<W extends MergeableWindow>(
    cropKey: string,
    windows: readonly W[],
    overrides: readonly LiveOverride[],
): { windows: W[]; unmatchedCorrections: string[] } {
    const mine = overrides.filter((o) => o.cropKey === cropKey);
    if (mine.length === 0) return { windows: [...windows], unmatchedCorrections: [] };

    const corrections = new Map(
        mine.filter((o) => o.origin === 'corrected').map((o) => [o.windowId, o]),
    );
    const additions = mine.filter((o) => o.origin === 'added');

    const matched = new Set<string>();
    const out: W[] = windows.map((w) => {
        const o = corrections.get(w.id);
        if (!o) return w;
        matched.add(w.id);
        return correctedWindow(w, o) as W;
    });

    for (const o of additions) out.push(addedWindow(o) as W);

    const unmatchedCorrections = [...corrections.keys()].filter((id) => !matched.has(id));
    return { windows: out, unmatchedCorrections };
}

function correctedWindow(published: MergeableWindow, o: LiveOverride): MergeableWindow {
    const supersedes: Superseded = {
        from: published.from,
        to: published.to,
        cites: published.cites ?? [],
    };
    // `cites` is DROPPED, not overwritten — see the docblock. Spreading the
    // override's window last also means a field the correction omits reverts
    // to nothing rather than silently inheriting the published value, which
    // matches storing the window whole.
    return {
        ...o.window,
        origin: 'corrected',
        basis: o.basis,
        supersedes,
    };
}

function addedWindow(o: LiveOverride): MergeableWindow {
    // No `supersedes`: there is nothing it replaced. Its absence is how a
    // client tells an addition from a correction without reading `origin`,
    // though `origin` is the field it should read.
    return { ...o.window, origin: 'added', basis: o.basis };
}

/**
 * Narrow a stored row's `windowJson` to a window, or reject it.
 *
 * A row written before a schema change can hold a shape the current code does
 * not accept. Returning null for it means that one override stops applying —
 * the published window shows through — rather than the whole calendar failing
 * to serve. A dataset-level fault should fail at boot; a single bad override
 * should not take the surface down with it.
 */
export function parseOverrideWindow(json: unknown): OverrideWindow | null {
    const parsed = OverrideWindowSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
}

/** For the console: the fields a correction may legally differ in. */
export function overrideDiffers(
    published: Pick<CalendarWindow, 'from' | 'to'>,
    o: OverrideWindow,
): boolean {
    return published.from !== o.from || published.to !== o.to;
}
