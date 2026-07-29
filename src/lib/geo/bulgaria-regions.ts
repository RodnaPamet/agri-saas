/**
 * Bulgaria oblast (province) catalogue — plain typed data, NO I/O.
 *
 * The 28 oblasti of Bulgaria with their ISO 3166-2 code, bilingual name
 * (Bulgarian + English) and polygon centroid (lat/lon). This is the
 * programmatic source of truth the Exchange uses for `regionCode` /
 * `regionName` / `lat` / `lon` on a listing and for the region dropdown.
 *
 * Codes + centroids are aligned with the bundled polygon asset
 * `public/geo/bg-oblasti.geojson` (geoBoundaries gbOpen BGR ADM1, CC-BY-4.0
 * — see `public/geo/README.md`): `code` === the geojson `shapeISO`, and each
 * centroid is the mean of that feature's exterior-ring vertices. Keep the
 * two in sync if the geojson is ever refreshed.
 *
 * This module performs no filesystem or network access — it is a static
 * const table safe to import from anywhere (client or server).
 */

export type RegionLevel = 'OBLAST';

export interface BulgariaRegion {
    /** ISO 3166-2:BG code, e.g. "BG-16" (Plovdiv). Matches geojson shapeISO. */
    code: string;
    /** English (latin) name. */
    nameEn: string;
    /** Bulgarian (cyrillic) name. */
    nameBg: string;
    level: RegionLevel;
    /** Polygon centroid latitude. */
    lat: number;
    /** Polygon centroid longitude. */
    lon: number;
}

/** The 28 oblasti, in ISO-code order (BG-01 … BG-28). */
export const BULGARIA_REGIONS: readonly BulgariaRegion[] = [
    { code: "BG-01", nameEn: "Blagoevgrad", nameBg: "Благоевград", level: "OBLAST", lat: 41.7438, lon: 23.4777 },
    { code: "BG-02", nameEn: "Burgas", nameBg: "Бургас", level: "OBLAST", lat: 42.452, lon: 27.3523 },
    { code: "BG-03", nameEn: "Varna", nameBg: "Варна", level: "OBLAST", lat: 43.2295, lon: 27.5145 },
    { code: "BG-04", nameEn: "Veliko Tarnovo", nameBg: "Велико Търново", level: "OBLAST", lat: 43.2098, lon: 25.5836 },
    { code: "BG-05", nameEn: "Vidin", nameBg: "Видин", level: "OBLAST", lat: 43.8402, lon: 22.7675 },
    { code: "BG-06", nameEn: "Vratsa", nameBg: "Враца", level: "OBLAST", lat: 43.3976, lon: 23.7695 },
    { code: "BG-07", nameEn: "Gabrovo", nameBg: "Габрово", level: "OBLAST", lat: 42.9422, lon: 25.2722 },
    { code: "BG-08", nameEn: "Dobrich", nameBg: "Добрич", level: "OBLAST", lat: 43.6565, lon: 27.787 },
    { code: "BG-09", nameEn: "Kardzhali", nameBg: "Кърджали", level: "OBLAST", lat: 41.5467, lon: 25.4322 },
    { code: "BG-10", nameEn: "Kyustendil", nameBg: "Кюстендил", level: "OBLAST", lat: 42.2911, lon: 22.8844 },
    { code: "BG-11", nameEn: "Lovech", nameBg: "Ловеч", level: "OBLAST", lat: 43.0665, lon: 24.562 },
    { code: "BG-12", nameEn: "Montana", nameBg: "Монтана", level: "OBLAST", lat: 43.4738, lon: 23.2406 },
    { code: "BG-13", nameEn: "Pazardzhik", nameBg: "Пазарджик", level: "OBLAST", lat: 42.1843, lon: 24.1358 },
    { code: "BG-14", nameEn: "Pernik", nameBg: "Перник", level: "OBLAST", lat: 42.6113, lon: 22.8531 },
    { code: "BG-15", nameEn: "Pleven", nameBg: "Плевен", level: "OBLAST", lat: 43.4433, lon: 24.5959 },
    { code: "BG-16", nameEn: "Plovdiv", nameBg: "Пловдив", level: "OBLAST", lat: 42.2285, lon: 24.8231 },
    { code: "BG-17", nameEn: "Razgrad", nameBg: "Разград", level: "OBLAST", lat: 43.6381, lon: 26.5224 },
    { code: "BG-18", nameEn: "Ruse", nameBg: "Русе", level: "OBLAST", lat: 43.6409, lon: 26.011 },
    { code: "BG-19", nameEn: "Silistra", nameBg: "Силистра", level: "OBLAST", lat: 43.9069, lon: 27.0925 },
    { code: "BG-20", nameEn: "Sliven", nameBg: "Сливен", level: "OBLAST", lat: 42.6555, lon: 26.2461 },
    { code: "BG-21", nameEn: "Smolyan", nameBg: "Смолян", level: "OBLAST", lat: 41.6248, lon: 24.6822 },
    { code: "BG-22", nameEn: "Sofia City", nameBg: "София (столица)", level: "OBLAST", lat: 42.6666, lon: 23.389 },
    { code: "BG-23", nameEn: "Sofia", nameBg: "София (област)", level: "OBLAST", lat: 42.6951, lon: 23.6125 },
    { code: "BG-24", nameEn: "Stara Zagora", nameBg: "Стара Загора", level: "OBLAST", lat: 42.372, lon: 25.5462 },
    { code: "BG-25", nameEn: "Targovishte", nameBg: "Търговище", level: "OBLAST", lat: 43.2546, lon: 26.3451 },
    { code: "BG-26", nameEn: "Haskovo", nameBg: "Хасково", level: "OBLAST", lat: 41.8531, lon: 25.9136 },
    { code: "BG-27", nameEn: "Shumen", nameBg: "Шумен", level: "OBLAST", lat: 43.3052, lon: 26.9996 },
    { code: "BG-28", nameEn: "Yambol", nameBg: "Ямбол", level: "OBLAST", lat: 42.3043, lon: 26.6058 },
] as const;

const REGION_BY_CODE: ReadonlyMap<string, BulgariaRegion> = new Map(
    BULGARIA_REGIONS.map((r) => [r.code, r]),
);

/** Look up an oblast by its ISO code; undefined for an unknown code. */
export function regionByCode(code: string): BulgariaRegion | undefined {
    return REGION_BY_CODE.get(code);
}

/** True when `code` is one of the 28 known oblast codes. */
export function isKnownRegionCode(code: string): boolean {
    return REGION_BY_CODE.has(code);
}

/**
 * The oblast name in `locale` — Bulgarian for `bg`, English otherwise, with
 * `fallback` (usually the row's stored `regionName`) for a code the catalogue
 * does not know.
 *
 * Rows persist the ENGLISH name as a stable, locale-independent record; every
 * user-facing surface renders through here instead, so a Bulgarian farmer sees
 * "Стара Загора" rather than "Stara Zagora" on data that was written once and
 * is read in two languages.
 */
export function localizedRegionName(
    code: string,
    locale: string,
    fallback?: string | null,
): string {
    const region = REGION_BY_CODE.get(code);
    if (!region) return fallback ?? code;
    return locale.startsWith('bg') ? region.nameBg : region.nameEn;
}

/**
 * Oblast codes whose Bulgarian OR English name contains `term`
 * (case-insensitive). Lets a free-text search match a region in either
 * language even though only one of the two names is stored on the row.
 */
export function regionCodesMatchingName(term: string): string[] {
    const q = term.trim().toLowerCase();
    if (!q) return [];
    return BULGARIA_REGIONS.filter(
        (r) => r.nameBg.toLowerCase().includes(q) || r.nameEn.toLowerCase().includes(q),
    ).map((r) => r.code);
}

export interface RegionOption {
    value: string;
    /** Bilingual label, e.g. "Пловдив / Plovdiv". */
    label: string;
}

/**
 * Dropdown options, sorted by Bulgarian name (Bulgarian-collation aware).
 * Label is bilingual so both a Bulgarian and an English reader recognise it.
 */
export const BULGARIA_REGION_OPTIONS: readonly RegionOption[] = [...BULGARIA_REGIONS]
    .sort((a, b) => a.nameBg.localeCompare(b.nameBg, 'bg'))
    .map((r) => ({ value: r.code, label: `${r.nameBg} / ${r.nameEn}` }));
