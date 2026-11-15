/**
 * THE RULE TABLE — one place, so the owner can read and correct it (#3070).
 *
 * Keyed `(dayType, phase)` → the three crop groups the owner named:
 * «Полски култури», «Зеленчукови», «Трайни насаждения».
 *
 * ## It holds KEYS, not sentences
 *
 * Every entry is an i18n key resolved from `messages/{bg,en}/app.json`. Three
 * reasons, all of which this repo has paid for: a channel is read in both
 * languages so copy composed here would pick one for every future reader; the
 * `no-server-authored-user-copy` ratchet is counting down server-authored
 * prose; and keys let one sentence appear in several cells without being
 * written twice and drifting.
 *
 * ## Blank cells are deliberate
 *
 * Where the tradition has nothing to say, the array is empty. Filling those in
 * would be the part most likely to read as our own agronomic advice, which is
 * precisely what the owner's framing rules out (2026-11-15: presented as folk
 * tradition, never as agronomic advice, never on the ДНЕВНИК surfaces).
 *
 * ## Copyright
 *
 * The element→organ mapping is a traditional idea and not anyone's property.
 * A specific PUBLISHED table of recommendations can be, so these sentences are
 * written rather than transcribed — which is also why the owner asked for the
 * dates to be computed rather than copied.
 */
import type { DayType } from './zodiac';
import type { Phase } from './moon';

/** The owner's three groups. */
export const CROP_GROUPS = ['field', 'vegetable', 'perennial'] as const;
export type CropGroup = (typeof CROP_GROUPS)[number];

/** Every recommendation this table can produce. Closed set, so the catalogue
 *  can be checked against it and an orphan key cannot hide. */
export const RECOMMENDATIONS = [
    'soilWork',
    'incorporateResidues',
    'sowBeetPotato',
    'sowCarrotRadishOnion',
    'rootPruning',
    'liftNurseryStock',
    'sowForageGrass',
    'sowLeafyVeg',
    'leafFeeding',
    'grafting',
    'cutLeafyForUse',
    'sowOilseedRape',
    'sowFloweringVeg',
    'cutFlowers',
    'formativePruning',
    'sowCerealGrain',
    'sowFruitingVeg',
    'plantTreesVines',
    'harvestForStorage',
    'harvestGrainForStorage',
    'seedSaving',
    'winterPruning',
] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

export type GroupAdvice = Readonly<Record<CropGroup, readonly Recommendation[]>>;

const EMPTY: GroupAdvice = { field: [], vegetable: [], perennial: [] };

/**
 * `dayType` × `phase` → advice per group.
 *
 * Exhaustive over both axes by TYPE, so a fifth day type or a third phase
 * cannot be added without this table refusing to compile — the
 * `Object.values(BookUseCase)` lesson, where a control naming members expired
 * silently when the vocabulary grew.
 */
export const RULES: Readonly<Record<DayType, Readonly<Record<Phase, GroupAdvice>>>> = {
    root: {
        waning: {
            field: ['sowBeetPotato'],
            vegetable: ['sowCarrotRadishOnion'],
            perennial: ['rootPruning', 'liftNurseryStock'],
        },
        waxing: {
            field: ['soilWork', 'incorporateResidues'],
            vegetable: [],
            perennial: [],
        },
    },
    leaf: {
        waxing: {
            field: ['sowForageGrass'],
            vegetable: ['sowLeafyVeg'],
            perennial: ['leafFeeding', 'grafting'],
        },
        waning: {
            field: [],
            vegetable: ['cutLeafyForUse'],
            perennial: [],
        },
    },
    flower: {
        waxing: {
            field: ['sowOilseedRape'],
            vegetable: ['sowFloweringVeg'],
            perennial: [],
        },
        waning: {
            field: [],
            vegetable: ['cutFlowers'],
            perennial: ['formativePruning'],
        },
    },
    fruit: {
        waxing: {
            field: ['sowCerealGrain'],
            vegetable: ['sowFruitingVeg'],
            perennial: ['plantTreesVines', 'harvestForStorage'],
        },
        waning: {
            field: ['harvestGrainForStorage'],
            vegetable: ['seedSaving'],
            perennial: ['winterPruning'],
        },
    },
};

export function adviceFor(dayType: DayType, phase: Phase): GroupAdvice {
    return RULES[dayType]?.[phase] ?? EMPTY;
}

/** The i18n key a recommendation resolves to. */
export function recommendationKey(rec: Recommendation): string {
    return `lunar.rec.${rec}`;
}
