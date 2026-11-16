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
import {
    CalendarDatasetSchema,
    type CalendarCostLineRow,
    type CalendarCosts,
    type CalendarCrop,
    type CalendarDataset,
    type CalendarRegion,
} from './schema';
import { perDaEurCents } from './costs';
import raw from './dataset.json';

/** A window as SERVED: `cites` normalised, `alsoCite` collapsed into it. */
export interface ServedWindow extends Omit<CalendarWindowInput, 'cite' | 'alsoCite'> {
    cites: { source: string; page: number | string }[];
}
type CalendarWindowInput = CalendarDataset['crops'][number]['windows'][number];

/**
 * One cost line as served: the published figure AND the derived euro one.
 *
 * Both, deliberately. `published` is what the card prints and is the only
 * figure any page supports — it is the traceable value, and it stays in
 * стотинки for `basis.areaDa`. `perDaEurCents` is what a client renders, and
 * it is computed HERE so the phone and the web cannot round differently and
 * disagree by a cent. Neither client holds the peg.
 */
export interface ServedCostLine extends CalendarCostLineRow {
    /** Euro cents per decare, rounded once. `null` if the basis is unusable. */
    perDaEurCents: number | null;
}

export interface ServedCosts extends Omit<CalendarCosts, 'lines'> {
    lines: ServedCostLine[];
    /**
     * Rounded ONCE from `publishedTotal`, not summed from the rounded lines.
     *
     * `publishedTotal` is a figure the card states in its own right, so it is
     * the thing to convert; building the total out of rounded parts would
     * publish a number no page supports. The loader already requires the lines
     * to sum to it in стотинки, so the two agree exactly on the current card —
     * measured, 56801 either way — but rounding is not additive in general, so
     * a future card may leave them a cent or two apart. When they differ, this
     * is the card's total and the lines are the card's lines; neither is
     * adjusted to tidy the arithmetic.
     */
    perDaEurCentsTotal: number | null;
}

export interface ServedCrop extends Omit<CalendarCrop, 'windows' | 'costs'> {
    windows: ServedWindow[];
    costs?: ServedCosts;
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

        /*
         * Published costs — #637. Three refusals, and the first is the one the
         * loop above would have missed: it ranges over WINDOW citations only,
         * so a `costs.cite` naming an absent source would have looked cited
         * and resolved to nothing, which is precisely the failure the window
         * check exists to prevent.
         */
        if (crop.costs) {
            if (!(crop.costs.cite.source in data.sources)) {
                unresolved.push(`${crop.key}.costs -> ${crop.costs.cite.source}`);
            }

            /*
             * THE LINES MUST SUM TO THE PRINTED TOTAL.
             *
             * This is why `publishedTotal` is stored rather than computed: the
             * card states it in its own right, so it is an independent figure
             * to check the five lines against. A total derived from the lines
             * could not catch a mistyped line — and it caught one during
             * authoring, where 4 177,79 лв had been transcribed as `411779`
             * instead of `417779`. Integer стотинки throughout, so this is
             * exact arithmetic with no tolerance to argue about.
             */
            const sum = crop.costs.lines.reduce((n, l) => n + l.published, 0);
            if (sum !== crop.costs.publishedTotal) {
                throw new Error(
                    `agro-calendar: ${crop.key} cost lines sum to ${sum} стотинки but the card's `
                        + `printed total is ${crop.costs.publishedTotal} — a difference of `
                        + `${Math.abs(sum - crop.costs.publishedTotal)}. One of them is mistyped, `
                        + `and serving either would misstate a published figure.`,
                );
            }

            // The enum closes which keys are LEGAL, not how many times one may
            // appear. A repeated key would double-count that line into the sum
            // and still satisfy the check above if another were short.
            const keys = crop.costs.lines.map((l) => l.key);
            const dupKeys = keys.filter((k, i) => keys.indexOf(k) !== i);
            if (dupKeys.length > 0) {
                throw new Error(
                    `agro-calendar: ${crop.key} repeats cost line(s): ${[...new Set(dupKeys)].join(', ')}`,
                );
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

/**
 * Published costs plus their euro derivation — #637.
 *
 * Costs ride on the CROP rather than on a route of their own: one priced card
 * does not justify a second surface, `/api/agro-calendar` already returns the
 * crop, and a separate endpoint would be a second place for the two to drift.
 * If МЗХ ever prices more cards this generalises with no migration.
 */
const servedCosts = (c: CalendarCosts): ServedCosts => ({
    ...c,
    lines: c.lines.map((l) => ({
        ...l,
        perDaEurCents: perDaEurCents(l.published, c.basis.areaDa),
    })),
    perDaEurCentsTotal: perDaEurCents(c.publishedTotal, c.basis.areaDa),
});

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
        .map(({ costs, windows, ...rest }): ServedCrop => ({
            ...rest,
            windows: windows
                .filter((w) => w.region === 'both' || w.region === query.region)
                .map(served),
            // Destructured out of the spread rather than overridden after it:
            // the raw block and the served one are different TYPES, and
            // spreading then replacing leaves tsc with a union it cannot
            // narrow — which is how a raw `costs` would have reached a client
            // with no `perDaEurCents` on it.
            ...(costs ? { costs: servedCosts(costs) } : {}),
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
