/**
 * The commodity slugs in the agro REFERENCE datasets (benchmarks,
 * thresholds) must be the canonical ones where a canonical one exists.
 *
 * Clients join these figures to a farm's crops on
 * `commodity-vocabulary`'s canonical values — `CropType.commodityCanonical`,
 * the calculator's rows, the calendar's `commodityCanonical`. A dataset
 * written with an alias (`canola` where the vocabulary says `rapeseed`)
 * loads, serves, and is found by no crop: a figure that exists and is never
 * shown. The first compile of the benchmarks did exactly that.
 *
 * A slug the vocabulary does not know at all (triticale, chickpeas) passes:
 * it has no canonical spelling to disagree with.
 */
import { normalizeCommodity } from '@/lib/market/commodity-vocabulary';

export function assertCanonicalSlug(dataset: string, where: string, slug: string): void {
    const canonical = normalizeCommodity(slug);
    if (canonical !== null && canonical !== slug) {
        throw new Error(`${dataset}: ${where} uses \`${slug}\`; the canonical commodity is \`${canonical}\``);
    }
}
