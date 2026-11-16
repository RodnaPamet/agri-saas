/**
 * Load, VALIDATE and query the agronomic calendar — «Агрономически календар».
 *
 * ## It refuses rather than serving a half-valid dataset
 *
 * The zod schema catches a malformed window. Three things it cannot catch need
 * checking across the whole document, and each fails in the direction that
 * reads as working:
 *
 *   - a `cite.source` naming a key the `sources` map does not hold. The window
 *     looks cited and resolves to nothing, which is the same as uncited except
 *     that nobody can tell.
 *   - a duplicate window `id`. The ids are how a correction is addressed
 *     (stage 2's per-window overrides), so two windows sharing one means a
 *     correction silently lands on whichever the merge reached first.
 *   - a crop with no windows, which renders as a heading with nothing under it.
 *
 * The dataset's own `conventions` header states the authoring side of this.
 * This is the enforcement, and it runs ONCE at module load: a bad merge fails
 * loudly at boot rather than per request.
 *
 * ## `cites` is normalised here, not in the route
 *
 * `cite` + `alsoCite` is convenient to AUTHOR; one ordered list is what a
 * client wants to render. Normalising at load means every consumer — this
 * route, stage 2's override merge, any later surface — sees the same shape,
 * rather than each one remembering to concatenate.
 */
import { CalendarDatasetSchema, type CalendarCrop, type CalendarDataset, type CalendarRegion } from './schema';
import raw from './dataset.json';

/** A window as SERVED: `cites` normalised, `alsoCite` collapsed into it. */
export interface ServedWindow extends Omit<CalendarWindowInput, 'cite' | 'alsoCite'> {
    cites: { source: string; page: number | string }[];
}
type CalendarWindowInput = CalendarDataset['crops'][number]['windows'][number];

export interface ServedCrop extends Omit<CalendarCrop, 'windows'> {
    windows: ServedWindow[];
}

/**
 * Exported so a test can feed it a CRAFTED dataset.
 *
 * The module below validates the real committed file at load, which proves it
 * accepts a good dataset and nothing about what it refuses. The refusals are
 * the point — each one fails in the direction that reads as working — and the
 * only way to exercise them is to hand it a bad document.
 */
export function validateDataset(input: unknown): CalendarDataset {
    const parsed = CalendarDatasetSchema.safeParse(input);
    if (!parsed.success) {
        throw new Error(
            `agro-calendar dataset is malformed and will NOT be served: ${parsed.error.message}`,
        );
    }
    const data = parsed.data;

    const seen = new Set<string>();
    const unresolved: string[] = [];
    const duplicates: string[] = [];
    for (const crop of data.crops) {
        for (const w of crop.windows) {
            if (seen.has(w.id)) duplicates.push(w.id);
            seen.add(w.id);
            for (const c of [w.cite, ...(w.alsoCite ?? [])]) {
                if (!(c.source in data.sources)) unresolved.push(`${w.id} -> ${c.source}`);
            }
            // A sowing window without a band loses the early/optimal/late
            // advice, which is the thing the owner asked for by name.
            if (w.kind === 'sowing' && !w.band) {
                throw new Error(`agro-calendar: sowing window ${w.id} has no band`);
            }
        }
    }
    if (duplicates.length > 0) {
        throw new Error(`agro-calendar: duplicate window id(s): ${duplicates.join(', ')}`);
    }
    if (unresolved.length > 0) {
        throw new Error(
            `agro-calendar: ${unresolved.length} citation(s) name a source that is not in the `
                + `sources map — a window that looks cited and resolves to nothing: `
                + unresolved.slice(0, 5).join('; '),
        );
    }
    return data;
}

/** Validated once per process. A bad dataset fails at boot, not per request. */
export const CALENDAR: CalendarDataset = validateDataset(raw);

const served = (w: CalendarWindowInput): ServedWindow => {
    const { cite, alsoCite, ...rest } = w;
    return { ...rest, cites: [cite, ...(alsoCite ?? [])] };
};

export interface CalendarQuery {
    region: CalendarRegion;
    group?: CalendarCrop['group'];
    crop?: string;
}

/**
 * The crops and windows for one region.
 *
 * A `both` window belongs to every region — that is what it means, and it is
 * 26 of the first 35 windows, so treating `both` as a third region rather than
 * as membership of the other two would serve almost nothing.
 *
 * A crop whose windows are ALL filtered out is dropped, not returned empty: a
 * heading with nothing under it reads as "we know about this crop and have
 * nothing to say", which is a different claim from not covering it.
 */
export function calendarFor(query: CalendarQuery): ServedCrop[] {
    return CALENDAR.crops
        .filter((c) => (query.group ? c.group === query.group : true))
        .filter((c) => (query.crop ? c.key === query.crop : true))
        .map((c) => ({
            ...c,
            windows: c.windows
                .filter((w) => w.region === 'both' || w.region === query.region)
                .map(served),
        }))
        .filter((c) => c.windows.length > 0);
}

/** Every crop key, for a client offering a picker and for the route's 400. */
export function calendarCropKeys(): string[] {
    return CALENDAR.crops.map((c) => c.key);
}

/**
 * Does this window run across the New Year?
 *
 * Exported because both the API's consumers and its tests need ONE answer:
 * ten of the 126 windows wrap (pruning, 15 December to 30 March), and a
 * consumer comparing `from <= today <= to` lexically gets those exactly
 * backwards — it would report pruning season for the eight months it is not.
 */
export function windowWraps(w: { from: string; to: string }): boolean {
    return w.from > w.to;
}

/**
 * Is `dayKey` (`MM-DD`) inside the window, wrap included?
 *
 * The reason `windowWraps` is not enough on its own: a caller still has to
 * know what to DO with the wrap, and the two branches are easy to get the
 * wrong way round. One implementation, tested in both directions.
 */
export function windowCovers(w: { from: string; to: string }, dayKey: string): boolean {
    return windowWraps(w)
        ? dayKey >= w.from || dayKey <= w.to
        : dayKey >= w.from && dayKey <= w.to;
}

/**
 * Every source the calendar actually CITES, derived from the windows.
 *
 * For the МЗХ discovery job (#639, backend-2's lane) to watch: a hash change
 * on one of these invalidates the CITATION and not merely the value, because a
 * republished PDF can move page 20 — so a window stays wrong while its dates
 * look unchanged, which reads as sourced. The job writes a revision row and
 * alerts; it never writes this file. One writer per artefact.
 *
 * DERIVED rather than listed, for the reason every other derivation here
 * exists: a static list goes stale the first time a crop cites a new card, and
 * the new source is then silently unwatched while the list still looks
 * complete.
 *
 * It returns the publisher too, because the watcher is МЗХ-scoped and the
 * calendar cites one non-МЗХ sheet (KWS). A watcher covering 12 of 13 that
 * reports "watching the calendar's sources" is the coverage-names-its-axis
 * shape, so the gap travels with the data rather than being implied.
 *
 * Sources present in the map but cited by NO window are excluded: an unused
 * entry is not something whose revision anybody needs to act on.
 */
export function citedSourceUrls(): { key: string; publisher: string; url: string }[] {
    const cited = new Set<string>();
    for (const crop of CALENDAR.crops) {
        for (const w of crop.windows) {
            for (const c of [w.cite, ...(w.alsoCite ?? [])]) cited.add(c.source);
        }
    }
    return [...cited]
        .sort()
        .map((key) => ({
            key,
            publisher: CALENDAR.sources[key].publisher,
            url: CALENDAR.sources[key].url,
        }));
}
