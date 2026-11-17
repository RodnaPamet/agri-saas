/**
 * Pest and disease thresholds (ПИВ) — agrent-ios#636.
 *
 * From МЗХ's «Ръководство за интегрирано производство на зърнено-житни
 * култури … и слънчоглед» (Dec 2024): for each pest or disease, the crops it
 * attacks, and per growth stage the density or damage above which control is
 * justified. Owner decision (2026-11-17, via the agrent-ios session): «Риск»
 * and treatment records answer «над прага ли е?» from it, and each
 * agronomic-calendar crop lists its key pests.
 *
 * ## The wording is plain Bulgarian; the FIGURE and the STAGE are the guide's
 *
 * A threshold is mixed prose ("10 % нападната листна маса под флаговия
 * лист") rather than a number with a unit, because the guide states it that
 * way and splitting it would invent a structure the page does not support.
 * Every entry cites its page, and an entry whose page gives no figure is
 * left out rather than served with a blank threshold.
 *
 * ## `crops` are the app's commodity slugs
 *
 * For the diseases they follow the guide's own specialised forms (f.sp.
 * tritici, hordei, avenae, secalis), never an inference about which crops
 * "usually" get it.
 */
import { z } from 'zod';

const Localised = z.object({ bg: z.string().min(1), en: z.string().min(1).optional() });

export const ThresholdLevelSchema = z.object({
    /** The growth stage or season the figure applies to («BBCH 31–32», «есен»). */
    stage: Localised,
    /** The threshold itself, as the guide states it. */
    threshold: Localised,
});

export const PestThresholdSchema = z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    kind: z.enum(['disease', 'pest']),
    name: Localised,
    /** The guide's own Latin name(s). */
    latin: z.string().min(1),
    crops: z.array(z.string().min(1)).min(1),
    levels: z.array(ThresholdLevelSchema).min(1),
    cite: z.object({
        source: z.string().min(1),
        page: z.union([z.number().int().positive(), z.string().min(1)]),
    }),
    note: Localised.optional(),
});

const Source = z.object({
    title: z.string().min(1),
    publisher: z.string().min(1),
    url: z.string().url(),
    published: z.string().regex(/^\d{4}(-\d{2})?$/).optional(),
});

export const ThresholdsDatasetSchema = z.object({
    schemaVersion: z.literal(1),
    compiledAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    conventions: z.array(z.string().min(1)),
    sources: z.record(z.string(), Source),
    thresholds: z.array(PestThresholdSchema).min(1),
});

export type ThresholdsDataset = z.infer<typeof ThresholdsDatasetSchema>;
export type PestThreshold = z.infer<typeof PestThresholdSchema>;
