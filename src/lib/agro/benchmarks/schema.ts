/**
 * National yields and coupled-support rates — agrent-ios#638.
 *
 * Owner decisions (2026-11-17, via the agrent-ios session): the phone shows
 * these in the calculator per crop, on each agronomic-calendar crop page, and
 * on a «Подпомагане» page; the support rates are shown AS PUBLISHED, in the
 * currency of the order that set them, with NO conversion (2026-11-06).
 *
 * ## Every figure is as its source prints it
 *
 * Yields are МЗХ Agrostatistics' kg/ha; rates are the minister's order's leva
 * per eligible hectare, held as integer стотинки (CLAUDE.md: money is never a
 * float). Nothing is divided, indexed or converted here — a derived figure is
 * a number no cited page supports. A client that wants kg/дка divides by 10,
 * which is exact.
 *
 * ## The citation is REQUIRED
 *
 * Same ruling as the calendar's: a figure without a page that supports it is
 * left out, not served uncited, and the loader refuses a dataset that breaks
 * it.
 */
import { z } from 'zod';

const Localised = z.object({ bg: z.string().min(1), en: z.string().min(1).optional() });

const Citation = z.object({
    source: z.string().min(1),
    /** The page carrying the figure; absent where the source is a one-page notice. */
    page: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
    /** The order's own numbered point (I–IX), where it has them. */
    point: z.string().min(1).optional(),
});

export const BenchmarkYieldSchema = z.object({
    /** The app's commodity slug (`wheat`, `canola`, …). */
    commodity: z.string().min(1),
    label: Localised,
    harvest: z.number().int().min(2000).max(2100),
    /** As printed: kilograms per hectare, a national average for the harvest. */
    kgPerHa: z.number().int().positive(),
    cite: Citation,
    note: Localised.optional(),
});

export const SupportRateSchema = z.object({
    scheme: z.string().min(1),
    label: Localised,
    campaign: z.number().int().min(2000).max(2100),
    /** The order's currency, as published. Not converted (owner, 2026-11-06). */
    currency: z.enum(['BGN', 'EUR']),
    /** Integer minor units per eligible hectare (стотинки for BGN, cents for EUR). */
    perHaStotinki: z.number().int().positive(),
    /** The rate above the 30th eligible hectare, where the order sets one. */
    perHaOver30Stotinki: z.number().int().positive().optional(),
    /** The app's commodity slugs the scheme covers, where it maps onto them. */
    commodities: z.array(z.string().min(1)).optional(),
    cite: Citation,
});

const Source = z.object({
    title: z.string().min(1),
    publisher: z.string().min(1),
    url: z.string().url(),
    published: z.string().regex(/^\d{4}(-\d{2})?$/).optional(),
});

export const BenchmarksDatasetSchema = z.object({
    schemaVersion: z.literal(1),
    compiledAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    conventions: z.array(z.string().min(1)),
    sources: z.record(z.string(), Source),
    yields: z.array(BenchmarkYieldSchema).min(1),
    supportRates: z.array(SupportRateSchema).min(1),
});

export type BenchmarksDataset = z.infer<typeof BenchmarksDatasetSchema>;
export type BenchmarkYield = z.infer<typeof BenchmarkYieldSchema>;
export type SupportRate = z.infer<typeof SupportRateSchema>;
