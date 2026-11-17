/**
 * Load and VALIDATE the pest and disease thresholds — agrent-ios#636.
 *
 * Validated once at module load, like the calendar: a bad merge fails at
 * boot rather than per request. Beyond the zod schema:
 *
 *   - a citation naming a source the map does not hold — a threshold that
 *     looks sourced and resolves to nothing;
 *   - a duplicate `id` — two entries a client cannot tell apart, one of
 *     which it will show and the other silently not.
 */
import { ThresholdsDatasetSchema, type PestThreshold, type ThresholdsDataset } from './schema';
import raw from './dataset.json';

export function validateThresholds(input: unknown): ThresholdsDataset {
    const parsed = ThresholdsDatasetSchema.safeParse(input);
    if (!parsed.success) {
        throw new Error(`agro-thresholds dataset is malformed and will NOT be served: ${parsed.error.message}`);
    }
    const data = parsed.data;

    const ids = new Set<string>();
    const unresolved: string[] = [];
    for (const t of data.thresholds) {
        if (ids.has(t.id)) throw new Error(`agro-thresholds: duplicate id ${t.id}`);
        ids.add(t.id);
        if (!(t.cite.source in data.sources)) unresolved.push(`${t.id} -> ${t.cite.source}`);
    }
    if (unresolved.length > 0) {
        throw new Error(
            `agro-thresholds: ${unresolved.length} citation(s) name a source that is not in the sources map: `
                + unresolved.slice(0, 5).join('; '),
        );
    }
    return data;
}

/** Validated once per process. */
export const THRESHOLDS: ThresholdsDataset = validateThresholds(raw);

/** Every crop some threshold covers, for refusing an unknown one. */
export function thresholdCrops(): string[] {
    return [...new Set(THRESHOLDS.thresholds.flatMap((t) => t.crops))].sort();
}

/** The thresholds for one crop; every threshold when none is given. */
export function thresholdsFor(crop?: string): PestThreshold[] {
    if (!crop) return THRESHOLDS.thresholds;
    return THRESHOLDS.thresholds.filter((t) => t.crops.includes(crop));
}
