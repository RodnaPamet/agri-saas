/**
 * Application techniques — the rig a spray or fertiliser job was applied with.
 *
 * `Task.applicationTechnique` is a free-text column (`String?`) and the write
 * schema accepts any string up to 255 chars, so this list is a VOCABULARY, not
 * a constraint. Production already contains values outside it — `dron` was
 * entered twice, in two different casings, before anything normalised the
 * field.
 *
 * ── Why the Bulgarian lives here as well as in `messages/` ──
 *
 * The web sheet renders these through next-intl, which needs them in
 * `messages/*.json`. The ДНЕВНИК renders them too — it is the БАБХ register's
 * "Техника за приложение" column — but a PDF generator is a synchronous,
 * locale-fixed surface: the form is always Bulgarian, and `buildChemicalRows`
 * is a pure function that its tests call directly. Making it async to reach
 * `translateFor` would ripple through every caller for one column.
 *
 * So there are two representations, and `tests/guards/application-technique-
 * vocabulary.test.ts` binds them: the map below must match
 * `ag.map.parcelSheet.techniqueOptions` exactly, in both directions. Two
 * sources with a guard is the repo's usual answer where one source is not
 * reachable; two sources without one is how `messages/` came to hold three
 * separate crop vocabularies.
 */

/** The seven the picker offers, in the order the web sheet lists them. */
export const APPLICATION_TECHNIQUES = [
    'boom',
    'ground',
    'airblast',
    'knapsack',
    'spreader',
    'drone',
    'other',
] as const;

export type ApplicationTechnique = (typeof APPLICATION_TECHNIQUES)[number];

/** Bulgarian, for the locale-fixed ДНЕВНИК. Mirrors `messages/bg.json`. */
const TECHNIQUE_BG: Record<ApplicationTechnique, string> = {
    boom: 'Щангова пръскачка',
    ground: 'Наземна пръскачка',
    airblast: 'Вентилаторна пръскачка',
    knapsack: 'Гръбна пръскачка',
    spreader: 'Разпръсквач на тор',
    drone: 'Дрон',
    other: 'Друго',
};

/**
 * Canonical form of a stored technique: trimmed and lower-cased.
 *
 * Applied on WRITE so the column cannot accumulate `Dron` beside `dron` again,
 * and on READ so rows written before that still resolve.
 */
export function normaliseTechnique(raw: string | null | undefined): string | null {
    if (raw == null) return null;
    const t = raw.trim().toLowerCase();
    return t.length > 0 ? t : null;
}

/**
 * The Bulgarian label for the register, or the stored value unchanged.
 *
 * Passthrough is the whole point: this column is free text, so an unrecognised
 * value is ordinary rather than exceptional, and a legally-filed register must
 * show what was recorded rather than a blank or a guess.
 */
export function techniqueLabelBg(raw: string | null | undefined): string {
    const slug = normaliseTechnique(raw);
    if (!slug) return '';
    return TECHNIQUE_BG[slug as ApplicationTechnique] ?? raw!.trim();
}

/** Exported for the guard that binds this map to `messages/bg.json`. */
export const _TECHNIQUE_BG_FOR_TESTS = TECHNIQUE_BG;
