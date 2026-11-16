/**
 * The agronomic calendar's dataset contract — «Агрономически календар».
 *
 * Owner decisions (2026-11-15/16, via the agrent-ios session): field crops,
 * vegetables and perennials; North and South Bulgaria; sowing windows with
 * early/optimal/late plus rate and depth; field work by stage with typical
 * dates; harvest windows. **Published WITH SOURCES**, every window cited, the
 * owner correcting afterwards.
 *
 * ## The citation is REQUIRED, which is the ruling made structural
 *
 * "Publish with sources" is only a rule if an uncited window cannot be served.
 * So `cite` is required here and the loader REFUSES a dataset that breaks it,
 * rather than serving the window with a blank source. The dataset's own
 * `conventions` header says the same thing from the authoring side — "a window
 * without a page that supports it is left out, not served uncited" — and this
 * is the half that enforces it.
 *
 * ## Units are a CLOSED SET, and `m²` is the reason
 *
 * The sources write rates as they please: 500-600 `seeds/m2` for wheat,
 * 35-50 `plants/m2` for rapeseed, 5000-5500 `plants/da` for sunflower. None is
 * converted — a converted figure is a number no cited page supports.
 *
 * A free-text unit would admit `m²` the moment somebody pastes from a PDF, and
 * then two units render differently and compare unequal with nothing failing.
 * Enumerated for the same reason `FROST_RISK` has one `level` rather than a
 * free label.
 *
 * ## `from > to` WRAPS the year
 *
 * Vine and stone-fruit pruning runs 15 December to 30 March — ten of the 126
 * windows wrap. It is one window, not two, and the consumer resolves the wrap;
 * splitting it in the data would hide that the window is continuous. Same
 * shape as the Moon's 360°→0° sign change, which cost a bisection bug when it
 * was treated as a numeric comparison.
 */
import { z } from 'zod';

/** `MM-DD`. No year: these recur annually. */
const DayOfYear = z
    .string()
    .regex(/^\d{2}-\d{2}$/, 'expected MM-DD with no year — windows recur annually');

/**
 * Enumerated, never free text — see the module docblock on `m²`.
 *
 * `kg/da` and `plants/da` are per DECAR, which is what Bulgarian practice and
 * every one of these sources uses. A silent kg/ha would be a 10x error in the
 * direction that costs a farmer a crop.
 */
export const CALENDAR_UNITS = ['seeds/m2', 'plants/m2', 'plants/da', 'kg/da', 'cm'] as const;

const Measure = z
    .object({
        min: z.number(),
        max: z.number(),
        unit: z.enum(CALENDAR_UNITS),
    })
    .refine((m) => m.min <= m.max, { message: 'min must not exceed max' });

const Citation = z.object({
    /** A key in the dataset's `sources` map — cross-checked by the loader. */
    source: z.string().min(1),
    /** The page carrying the figure. A string, because some cards cite "20-21". */
    page: z.union([z.number().int().positive(), z.string().min(1)]),
});

const Localised = z.object({ bg: z.string().min(1), en: z.string().min(1).optional() });

export const CalendarWindowSchema = z.object({
    id: z.string().min(1),
    kind: z.enum(['sowing', 'fieldwork', 'harvest']),
    /** Required for `sowing` — early/optimal/late is explicitly what was asked for. */
    band: z.enum(['early', 'optimal', 'late']).optional(),
    region: z.enum(['north', 'south', 'both']),
    from: DayOfYear,
    to: DayOfYear,
    /** The guide's own stage wording — `bbch` alone cannot say "before sowing". */
    title: Localised.optional(),
    /** Quoted or closely paraphrased from the cited page. */
    note: Localised.optional(),
    stage: z.object({ bbch: z.string().min(1).optional() }).optional(),
    work: z.string().min(1).optional(),
    seedRate: Measure.optional(),
    depth: Measure.optional(),
    density: Measure.optional(),
    cite: Citation,
    /**
     * Additional pages, when one window rests on more than one.
     * A harvest window's start and completion come from two different weekly
     * bulletins, so there is no "primary" in any meaningful sense — which is
     * why the API serves them as one ordered `cites` list.
     */
    alsoCite: z.array(Citation).optional(),
});

export const CalendarCropSchema = z.object({
    key: z.string().min(1),
    group: z.enum(['field', 'vegetable', 'perennial']),
    /** Joins `CropType.commodityCanonical` where one exists. Absent for most
     * vegetables and perennials, which have no canonical commodity. */
    commodityCanonical: z.string().min(1).optional(),
    name: Localised,
    windows: z.array(CalendarWindowSchema).min(1),
});

export const CalendarSourceSchema = z.object({
    title: z.string().min(1),
    publisher: z.string().min(1),
    url: z.string().min(1),
    published: z.string().min(1).optional(),
});

export const CalendarDatasetSchema = z.object({
    schemaVersion: z.literal(1),
    compiledAt: z.string().min(1),
    /** The authoring rules, shipped with the data so a reader sees them. */
    conventions: z.array(z.string().min(1)).min(1),
    sources: z.record(z.string(), CalendarSourceSchema),
    crops: z.array(CalendarCropSchema).min(1),
});

export type CalendarDataset = z.infer<typeof CalendarDatasetSchema>;
export type CalendarWindow = z.infer<typeof CalendarWindowSchema>;
export type CalendarCrop = z.infer<typeof CalendarCropSchema>;
export type CalendarRegion = 'north' | 'south';
