/**
 * P2.6 — the product's nouns are DERIVED from `docs/nav-vocabulary.md`.
 *
 * A surface with two names has none. Before P2.6 the exchange was «Борса» in
 * the sidebar section header, the breadcrumbs and the map legend, «Пазар» in
 * the sidebar item that navigated to it, and `Борса / Exchange` in the page
 * heading — three spellings of one destination across four files, and every
 * suite green. Trends was «Тренд» where you clicked it and «тенденции» in
 * every sentence about it.
 *
 * ── why this guard parses a DOC ──
 *
 * The phase plan requires an owner reversal to be a one-file edit
 * (`docs/nav-vocabulary.md` is named in it). A guard with the nouns hard-coded
 * in TypeScript would make the doc a MIRROR — decorative, free to rot, and a
 * reversal would be two files with nothing checking they agree. So the doc's
 * table IS the expectation: change «Борса» there and this test immediately
 * names every catalogue key that still says the old noun.
 *
 * That inverts the usual failure too. A guard that restates its subject goes
 * stale silently; one that reads the written decision cannot — if the doc is
 * deleted, renamed or restructured, `parseVocabulary` THROWS rather than
 * returning an empty table, because an empty selection is a pass.
 *
 * ── the two assertions, and why neither subsumes the other ──
 *
 *   1. Each listed key holds the canonical noun EXACTLY, in both catalogues.
 *      Catches a key that drifted, or a new surface wired to the wrong label.
 *   2. No key under the concept's namespaces holds a BANNED noun as its whole
 *      value. Catches the convergence reversing one key at a time somewhere
 *      the table does not list — which is how it got into this state: nothing
 *      in the repo said `sidebarNav.marketplace` was the odd one out.
 *
 * (1) is positive and bounded; (2) is negative and open-ended. A key could
 * satisfy (1) while a sibling added next month fails (2), and a namespace
 * could be clean under (2) while a listed key says the wrong thing.
 *
 * `Пазар` stays legal as a news CATEGORY and in price copy («пазарна цена»,
 * «пазарни тенденции»): the ban is on the whole VALUE of an `exchange*` key,
 * never on the word.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const DOC = path.join(ROOT, 'docs/nav-vocabulary.md');

export interface VocabularyRow {
    concept: string;
    bg: string;
    en: string;
    keys: string[];
    never: string[];
    namespaces: string[];
}

/**
 * Parse the one table in `docs/nav-vocabulary.md` whose header is
 * `Concept | Bulgarian | English | Keys | Never | Namespaces`.
 *
 * Exported for the mutation proof below, which feeds it synthetic docs —
 * including a doc with no such table, because "found nothing" must be an
 * ERROR here and not a clean run.
 */
export function parseVocabulary(markdown: string): VocabularyRow[] {
    const lines = markdown.split(/\r?\n/);
    const cells = (line: string) =>
        line
            .replace(/^\s*\|/, '')
            .replace(/\|\s*$/, '')
            .split('|')
            .map((c) => c.trim());

    const headerIdx = lines.findIndex((l) => {
        if (!l.trim().startsWith('|')) return false;
        const c = cells(l).map((x) => x.toLowerCase());
        return (
            c.length === 6 &&
            c[0] === 'concept' &&
            c[1] === 'bulgarian' &&
            c[2] === 'english' &&
            c[3] === 'keys' &&
            c[4] === 'never' &&
            c[5] === 'namespaces'
        );
    });
    if (headerIdx === -1) {
        throw new Error(
            'docs/nav-vocabulary.md: no table with the header ' +
                '`Concept | Bulgarian | English | Keys | Never | Namespaces`. ' +
                'This guard DERIVES its expectations from that table — a missing ' +
                'or restructured one would otherwise check nothing and pass.',
        );
    }

    const rows: VocabularyRow[] = [];
    // Skip the header and the `|---|` separator beneath it.
    for (let i = headerIdx + 2; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim().startsWith('|')) break; // table ended
        const c = cells(line);
        if (c.length !== 6) {
            throw new Error(
                `docs/nav-vocabulary.md:${i + 1}: expected 6 cells, got ${c.length} — ${line.trim()}`,
            );
        }
        const list = (s: string) =>
            s
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean);
        rows.push({
            concept: c[0],
            bg: c[1],
            en: c[2],
            keys: list(c[3]),
            never: list(c[4]),
            namespaces: list(c[5]),
        });
    }
    if (rows.length === 0) {
        throw new Error('docs/nav-vocabulary.md: the vocabulary table has no rows.');
    }
    return rows;
}

type Flat = Map<string, string>;

function flatten(obj: unknown, prefix = '', out: Flat = new Map()): Flat {
    if (obj === null || typeof obj !== 'object') return out;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const full = prefix ? `${prefix}.${k}` : k;
        if (v !== null && typeof v === 'object') flatten(v, full, out);
        else if (typeof v === 'string') out.set(full, v);
    }
    return out;
}

export interface Violation {
    kind: 'wrong-value' | 'missing-key' | 'banned-noun';
    concept: string;
    locale: string;
    key: string;
    detail: string;
}

/** Exported for the mutation proof — see the self-test block. */
export function findViolations(
    rows: readonly VocabularyRow[],
    catalogues: ReadonlyArray<{ locale: string; flat: Flat; expected: (r: VocabularyRow) => string }>,
): Violation[] {
    const out: Violation[] = [];
    for (const row of rows) {
        for (const { locale, flat, expected } of catalogues) {
            const want = expected(row);
            for (const key of row.keys) {
                const got = flat.get(key);
                if (got === undefined) {
                    out.push({
                        kind: 'missing-key',
                        concept: row.concept,
                        locale,
                        key,
                        detail: `absent from messages/${locale}.json`,
                    });
                } else if (got !== want) {
                    out.push({
                        kind: 'wrong-value',
                        concept: row.concept,
                        locale,
                        key,
                        detail: `is "${got}", must be "${want}"`,
                    });
                }
            }
        }
    }
    // The banned-noun sweep is Bulgarian-only: the table's Never column lists
    // Bulgarian nouns, and the English half of the convergence is already
    // pinned by the exact-value check above.
    //
    // The skip is over EVERY row's pinned keys, not just this row's. That is
    // what lets a namespace be wide enough to have teeth: `sidebarNav.` can ban
    // «Борса» for the `market` concept precisely because `sidebarNav.exchange`
    // — pinned TO «Борса» by the `exchange` row — is excluded. Skipping only
    // the current row's keys would force each namespace down to the keys it
    // already pins, and the sweep would range over nothing: a gate narrow
    // enough to always pass.
    const pinnedAnywhere = new Set(rows.flatMap((r) => r.keys));
    const bg = catalogues.find((c) => c.locale === 'bg');
    if (bg) {
        for (const row of rows) {
            if (row.never.length === 0) continue;
            for (const [key, value] of bg.flat) {
                const inScope = row.namespaces.some((ns) => key === ns || key.startsWith(ns));
                if (!inScope) continue;
                if (pinnedAnywhere.has(key)) continue; // covered exactly above
                if (row.never.includes(value.trim())) {
                    out.push({
                        kind: 'banned-noun',
                        concept: row.concept,
                        locale: 'bg',
                        key,
                        detail: `is "${value}", a noun docs/nav-vocabulary.md reserves for another surface`,
                    });
                }
            }
        }
    }
    return out;
}

describe('nav vocabulary — derived from docs/nav-vocabulary.md', () => {
    const rows = parseVocabulary(fs.readFileSync(DOC, 'utf8'));
    const bgFlat = flatten(JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/bg.json'), 'utf8')));
    const enFlat = flatten(JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8')));
    const catalogues = [
        { locale: 'bg', flat: bgFlat, expected: (r: VocabularyRow) => r.bg },
        { locale: 'en', flat: enFlat, expected: (r: VocabularyRow) => r.en },
    ];
    const violations = findViolations(rows, catalogues);

    it('the table and the catalogues are a real population, not an empty one', () => {
        // The positive control. Every assertion below ranges over `rows` and
        // the two flattened catalogues; a parse that found nothing, or a
        // catalogue read as an empty object, reports zero violations and looks
        // perfect. The numbers are printed so being wrong is visible.
        const keyCount = rows.reduce((n, r) => n + r.keys.length, 0);
        // eslint-disable-next-line no-console
        console.log(
            `[nav-vocabulary] ${rows.length} concepts, ${keyCount} pinned keys, ` +
                `${bgFlat.size} bg / ${enFlat.size} en strings swept`,
        );
        expect(rows.length).toBeGreaterThanOrEqual(3);
        expect(keyCount).toBeGreaterThanOrEqual(10);
        expect(bgFlat.size).toBeGreaterThan(4000);
        expect(enFlat.size).toBe(bgFlat.size);
    });

    it('every pinned key holds its canonical noun in BOTH catalogues', () => {
        const bad = violations.filter((v) => v.kind !== 'banned-noun');
        if (bad.length > 0) {
            throw new Error(
                `${bad.length} key(s) do not match docs/nav-vocabulary.md:\n` +
                    bad.map((v) => `  [${v.concept}] ${v.locale}: ${v.key} ${v.detail}`).join('\n') +
                    '\n\nEither fix the catalogue, or — if the owner changed the noun — ' +
                    'the doc is the source and this list is your work order.',
            );
        }
        expect(bad).toHaveLength(0);
    });

    it('no key in a concept’s namespaces carries a reserved noun', () => {
        const bad = violations.filter((v) => v.kind === 'banned-noun');
        if (bad.length > 0) {
            throw new Error(
                `${bad.length} key(s) use a noun reserved for a different surface:\n` +
                    bad.map((v) => `  [${v.concept}] ${v.key} ${v.detail}`).join('\n'),
            );
        }
        expect(bad).toHaveLength(0);
    });
});

// ─── Mutation proof ────────────────────────────────────────────────────────
//
// `selector-teeth` mutates a selector and checks something fails. Both seams
// here fail toward GREEN when broken: a parser that finds no table reports no
// violations, and a checker that compares nothing reports none either. So each
// is driven against synthetic inputs where the answer is known.
describe('nav-vocabulary detector self-test', () => {
    const DOC_FIXTURE = [
        'preamble prose',
        '',
        '| Concept | Bulgarian | English | Keys | Never | Namespaces |',
        '|---|---|---|---|---|---|',
        '| widget | Уиджет | Widget | a.one, a.two | Гаджет | a. |',
        '',
        'trailing prose',
    ].join('\n');

    it('parses a well-formed table', () => {
        const rows = parseVocabulary(DOC_FIXTURE);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual({
            concept: 'widget',
            bg: 'Уиджет',
            en: 'Widget',
            keys: ['a.one', 'a.two'],
            never: ['Гаджет'],
            namespaces: ['a.'],
        });
    });

    it('REFUSES a doc with no vocabulary table instead of returning []', () => {
        expect(() => parseVocabulary('# just a heading\n\nno table here.\n')).toThrow(
            /no table with the header/,
        );
    });

    it('REFUSES a table whose header is present but whose body is empty', () => {
        const headerOnly = DOC_FIXTURE.split('\n').slice(0, 4).join('\n');
        expect(() => parseVocabulary(headerOnly)).toThrow(/no rows/);
    });

    it('REFUSES a row with the wrong number of cells', () => {
        const short = DOC_FIXTURE.replace('| widget | Уиджет | Widget | a.one, a.two | Гаджет | a. |', '| widget | Уиджет |');
        expect(() => parseVocabulary(short)).toThrow(/expected 6 cells/);
    });

    const rows = parseVocabulary(DOC_FIXTURE);
    const cat = (bg: Record<string, string>, en: Record<string, string>) => [
        { locale: 'bg', flat: new Map(Object.entries(bg)), expected: (r: VocabularyRow) => r.bg },
        { locale: 'en', flat: new Map(Object.entries(en)), expected: (r: VocabularyRow) => r.en },
    ];

    it('passes a catalogue that agrees with the table', () => {
        expect(
            findViolations(
                rows,
                cat(
                    { 'a.one': 'Уиджет', 'a.two': 'Уиджет', 'a.other': 'нещо друго' },
                    { 'a.one': 'Widget', 'a.two': 'Widget', 'a.other': 'something else' },
                ),
            ),
        ).toEqual([]);
    });

    it('reports a key whose value drifted', () => {
        const v = findViolations(
            rows,
            cat({ 'a.one': 'Гаджет', 'a.two': 'Уиджет' }, { 'a.one': 'Widget', 'a.two': 'Widget' }),
        );
        expect(v.map((x) => [x.kind, x.locale, x.key])).toEqual([['wrong-value', 'bg', 'a.one']]);
    });

    it('reports a pinned key that is absent', () => {
        const v = findViolations(rows, cat({ 'a.one': 'Уиджет' }, { 'a.one': 'Widget' }));
        expect(v.filter((x) => x.kind === 'missing-key').map((x) => `${x.locale}:${x.key}`)).toEqual([
            'bg:a.two',
            'en:a.two',
        ]);
    });

    it('reports a reserved noun on an unlisted key in the namespace', () => {
        const v = findViolations(
            rows,
            cat(
                { 'a.one': 'Уиджет', 'a.two': 'Уиджет', 'a.three': 'Гаджет' },
                { 'a.one': 'Widget', 'a.two': 'Widget', 'a.three': 'Gadget' },
            ),
        );
        expect(v.map((x) => [x.kind, x.key])).toEqual([['banned-noun', 'a.three']]);
    });

    it('does NOT report a noun another row PINS inside the same namespace', () => {
        // The cross-row skip. Two concepts sharing a namespace is the normal
        // case (`sidebarNav.` holds both «Борса» and «Пазар»), and without
        // this each row's sweep would have to shrink to the keys it already
        // pins — i.e. range over nothing.
        const twoRows = parseVocabulary(
            [
                '| Concept | Bulgarian | English | Keys | Never | Namespaces |',
                '|---|---|---|---|---|---|',
                '| widget | Уиджет | Widget | a.one | Гаджет | a. |',
                '| gadget | Гаджет | Gadget | a.two | Уиджет | a. |',
            ].join('\n'),
        );
        const v = findViolations(
            twoRows,
            cat({ 'a.one': 'Уиджет', 'a.two': 'Гаджет' }, { 'a.one': 'Widget', 'a.two': 'Gadget' }),
        );
        expect(v).toEqual([]);
    });

    it('does NOT report a reserved noun outside the namespace', () => {
        const v = findViolations(
            rows,
            cat(
                { 'a.one': 'Уиджет', 'a.two': 'Уиджет', 'b.three': 'Гаджет' },
                { 'a.one': 'Widget', 'a.two': 'Widget', 'b.three': 'Gadget' },
            ),
        );
        expect(v).toEqual([]);
    });

    it('does NOT report a reserved noun used INSIDE a longer sentence', () => {
        // The ban is on the whole value, never on the word — «пазарна цена»
        // and «пазарни тенденции» are the commodity market, not the exchange.
        const v = findViolations(
            rows,
            cat(
                { 'a.one': 'Уиджет', 'a.two': 'Уиджет', 'a.four': 'Това е Гаджет и нещо още' },
                { 'a.one': 'Widget', 'a.two': 'Widget', 'a.four': 'This mentions Gadget' },
            ),
        );
        expect(v).toEqual([]);
    });
});
