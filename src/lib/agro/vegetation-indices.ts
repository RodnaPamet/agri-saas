/**
 * Vegetation-index catalogue (client-safe).
 *
 * The single source of truth for the map's satellite index overlays —
 * the toolbar toggle buttons, the legend ramp, and the tile-route slug all
 * read from here so adding an index is one entry, not five copy-pasted
 * blocks. The Earth-Engine band math + `getMap` palette live server-side in
 * `earth-engine.ts` (which imports only the `VegetationIndex` type from
 * here); this module carries NO server dependency so it is safe to import
 * from the client bundle.
 *
 * All five are computed from a recent cloud-masked Sentinel-2 median
 * composite over a 30-day window (see `earth-engine.ts`). Only one overlay
 * is ever active at a time — they are mutually exclusive on the map.
 */

/** Stable id for a satellite index overlay. Drives the tile-route slug. */
export type VegetationIndex = 'ndvi' | 'ndmi' | 'ndre' | 'gndvi' | 'evi';

export interface VegetationIndexUi {
    /** Stable id — also the `/agro/<id>-tiles` route slug prefix. */
    id: VegetationIndex;
    /** Toolbar button label + legend caption (the accessible name). */
    label: string;
    /** Tenant-scoped tile route, e.g. `ndvi-tiles`. */
    route: string;
    /**
     * Legend caption keys at the LOW / HIGH ends of the ramp, under
     * `agroEnums.indexLegend.*`.
     *
     * KEYS, not English. These were literals (`'Low'`, `'Dry'`) rendered
     * verbatim by both consumers, so a Bulgarian operator read "Low" and
     * "High" under a legend on an otherwise translated screen — and no
     * vocabulary existed to reach for, so the native client would have
     * created the first one. The wording here is shared with it deliberately,
     * the same way `authEnums` is, rather than each side inventing its own.
     */
    lowKey: 'low' | 'dry';
    highKey: 'high' | 'wet';
    /**
     * Tailwind arbitrary-value background for the legend swatch — a 5-stop
     * `linear-gradient(to right, …)` that mirrors the server `getMap`
     * palette closely enough to read as the same ramp.
     */
    legendGradientClass: string;
}

/**
 * The overlays, in toolbar order. NDVI (structure/vigour) leads; NDMI
 * (canopy/soil moisture), NDRE (red-edge chlorophyll), GNDVI (green
 * chlorophyll) and EVI (enhanced, atmosphere/soil-corrected) follow. Each
 * ramp hue is kept distinct so two legends never read the same.
 */
export const VEGETATION_INDICES: readonly VegetationIndexUi[] = [
    {
        id: 'ndvi',
        label: 'NDVI',
        route: 'ndvi-tiles',
        lowKey: 'low',
        highKey: 'high',
        // RdYlGn — canopy vigour.
        legendGradientClass:
            'bg-[linear-gradient(to_right,#a50026,#f46d43,#fee08b,#a6d96a,#006837)]',
    },
    {
        id: 'ndmi',
        label: 'NDMI',
        route: 'ndmi-tiles',
        lowKey: 'dry',
        highKey: 'wet',
        // RdYlBu — canopy/soil moisture (water stress red → wet blue).
        legendGradientClass:
            'bg-[linear-gradient(to_right,#a50026,#f46d43,#fee090,#abd9e9,#313695)]',
    },
    {
        id: 'ndre',
        label: 'NDRE',
        route: 'ndre-tiles',
        lowKey: 'low',
        highKey: 'high',
        // PRGn — red-edge chlorophyll, distinct purple→green hue.
        legendGradientClass:
            'bg-[linear-gradient(to_right,#762a83,#c2a5cf,#f7f7f7,#a6dba0,#00441b)]',
    },
    {
        id: 'gndvi',
        label: 'GNDVI',
        route: 'gndvi-tiles',
        lowKey: 'low',
        highKey: 'high',
        // YlGn — green-band chlorophyll sensitivity.
        legendGradientClass:
            'bg-[linear-gradient(to_right,#ffffe5,#d9f0a3,#78c679,#238443,#004529)]',
    },
    {
        id: 'evi',
        label: 'EVI',
        route: 'evi-tiles',
        lowKey: 'low',
        highKey: 'high',
        // Viridis — enhanced VI, distinct from the other greens.
        legendGradientClass:
            'bg-[linear-gradient(to_right,#440154,#3b528b,#21918c,#5ec962,#fde725)]',
    },
] as const;

/** Lookup by id (undefined for an unknown slug). */
export function vegetationIndexById(
    id: string | null | undefined,
): VegetationIndexUi | undefined {
    return VEGETATION_INDICES.find((v) => v.id === id);
}
