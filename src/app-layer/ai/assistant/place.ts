/**
 * The field a treatment was done on, from what the farmer SAID — agri-saas#3162.
 *
 * Owner ruling 2026-11-17: the assistant asks until a treatment is complete,
 * field included, then opens «Нов запис» filled. The farmer names the field
 * three ways, all three wanted: a block's name, a parcel or cadastral number,
 * or a crop. The model passes the WORDS; this resolves them to parcels the
 * person can read, through `listParcelPlaceOptions`. The model never sends or
 * sees an id it could have invented — the ids in the draft come from this
 * read, which is the `links.ts` guarantee applied to a draft.
 *
 * ## A word that does not resolve to exactly one thing is a QUESTION
 *
 * Two blocks whose names both contain «север», or a number matching nothing,
 * are not guessed at: they come back as `unresolved`, with the candidates
 * named, for the model to ask about. A wrong field in a regulated register is
 * worse than one more question.
 */
import { listParcelPlaceOptions } from '@/app-layer/usecases/parcel';
import type { RequestContext } from '@/app-layer/types';
import { normalizeCommodity } from '@/lib/market/commodity-vocabulary';

export interface PlaceWords {
    /** A block («Север»): every parcel in it. */
    readonly block?: string;
    /** Parcel names or cadastral numbers, one parcel each. */
    readonly parcels?: readonly string[];
    /** A crop («пшеница»): every parcel growing it. */
    readonly crop?: string;
}

export interface ResolvedParcel {
    readonly id: string;
    /** «Север · Парцел 3», for the form and the model alike. */
    readonly label: string;
    /**
     * The parcel's stored crop. The form records ONE crop per treatment — it
     * picks the crop, then that crop's parcels — so it needs the crop to open
     * on, and the tool needs it to ask when a field spans two.
     */
    readonly crop: string | null;
}

export interface Unresolved {
    readonly said: string;
    /** Up to five names to offer back, when the word matched several. */
    readonly candidates: readonly string[];
}

export interface PlaceResolution {
    readonly parcels: readonly ResolvedParcel[];
    readonly unresolved: readonly Unresolved[];
}

type Option = Awaited<ReturnType<typeof listParcelPlaceOptions>>[number];

/** Lower case, trimmed, inner spaces collapsed, a leading «блок»/«парцел»/«имот» dropped. */
export function fold(word: string): string {
    return word
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^(блок|блока|парцел|парцела|имот|имота|нива|нивата)\s+/u, '')
        .replace(/[«»"„“]/g, '')
        .trim();
}

/** A cadastral number compared without spaces: «12345.67.89». */
function compact(word: string): string {
    return word.replace(/\s+/g, '').toLowerCase();
}

function label(o: Option): string {
    return `${o.locationName} · ${o.name}`;
}

function sameCrop(said: string, stored: string | null): boolean {
    if (!stored) return false;
    if (fold(said) === fold(stored)) return true;
    const a = normalizeCommodity(said);
    return a !== null && a === normalizeCommodity(stored);
}

/** Resolve the words against one read of the farm's parcels. */
export function resolveAgainst(options: readonly Option[], words: PlaceWords): PlaceResolution {
    const chosen = new Map<string, ResolvedParcel>();
    const unresolved: Unresolved[] = [];
    const take = (o: Option) => chosen.set(o.id, { id: o.id, label: label(o), crop: o.cropType });

    if (words.block !== undefined) {
        const said = fold(words.block);
        const blocks = new Map<string, string>();
        for (const o of options) blocks.set(o.locationId, o.locationName);
        let hits = [...blocks].filter(([, name]) => fold(name) === said);
        if (hits.length === 0) hits = [...blocks].filter(([, name]) => said !== '' && fold(name).includes(said));
        if (hits.length === 1) {
            const [id] = hits[0] as [string, string];
            options.filter((o) => o.locationId === id).forEach(take);
        } else {
            unresolved.push({ said: words.block, candidates: hits.slice(0, 5).map(([, n]) => n) });
        }
    }

    for (const raw of words.parcels ?? []) {
        const said = fold(raw);
        let hits = options.filter((o) => (o.cadastralId && compact(o.cadastralId) === compact(said)) || fold(o.name) === said);
        if (hits.length === 0 && said !== '') hits = options.filter((o) => fold(o.name).includes(said));
        if (hits.length === 1) take(hits[0] as Option);
        else unresolved.push({ said: raw, candidates: hits.slice(0, 5).map(label) });
    }

    if (words.crop !== undefined) {
        const hits = options.filter((o) => sameCrop(words.crop as string, o.cropType));
        if (hits.length > 0) hits.forEach(take);
        else {
            const grown = [...new Set(options.map((o) => o.cropType).filter((c): c is string => !!c))];
            unresolved.push({ said: words.crop, candidates: grown.slice(0, 5) });
        }
    }

    return { parcels: [...chosen.values()], unresolved };
}

/**
 * Why resolved parcels cannot go on ONE treatment record, or null when they
 * can. The form records one crop per treatment and lists only parcels that
 * carry a crop, so a field spanning two crops, or a parcel with none, is a
 * question to ask rather than a form that cannot show what it was given.
 */
export function oneCropProblem(parcels: readonly ResolvedParcel[]): Unresolved | null {
    const bare = parcels.filter((p) => !p.crop?.trim());
    if (bare.length > 0) {
        return {
            said: 'field has no crop recorded — set the crop in Блокове, or name other parcels',
            candidates: bare.slice(0, 5).map((p) => p.label),
        };
    }
    const crops = [...new Set(parcels.map((p) => (p.crop as string).trim().toLowerCase()))];
    if (crops.length > 1) {
        return {
            said: 'these parcels grow different crops — one treatment record covers one crop; ask which',
            candidates: [...new Set(parcels.map((p) => p.crop as string))].slice(0, 5),
        };
    }
    return null;
}

/** Resolve the words for the caller's farm. A READ; writes nothing. */
export async function resolvePlace(ctx: RequestContext, words: PlaceWords): Promise<PlaceResolution> {
    if (words.block === undefined && !words.parcels?.length && words.crop === undefined) {
        return { parcels: [], unresolved: [] };
    }
    return resolveAgainst(await listParcelPlaceOptions(ctx), words);
}
