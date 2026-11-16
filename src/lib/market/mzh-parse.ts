/**
 * Reading МЗХ's «Оперативен анализ» — the weekly purchase prices (#3136).
 *
 * Two parsers, because the source is two artefacts: an HTML listing page that
 * says which bulletins exist, and the bulletin PDF's extracted text. Neither
 * fetches anything; both take strings, so both are testable against a
 * checked-in fixture of the real thing.
 *
 * ## Why a listing page at all
 *
 * URL construction does not work, measured across six published bulletins:
 * the directory is the PUBLISH date and the filename carries the BULLETIN
 * date, and they usually differ by a day (sometimes not), and some filenames
 * carry a random suffix (`operativen_analiz_2026-09-23_qUiH6H4.pdf`) while
 * others do not. A job guessing `.../YYYY/MM/DD/operativen_analiz_YYYY-MM-DD
 * .pdf` therefore finds some weeks and silently misses others — the worst
 * shape, because a miss is indistinguishable from "no bulletin was published".
 *
 * ## Only the grain table, and only part of it
 *
 * Owner rulings 2026-11-16, both made with the measured bulletin in hand:
 *
 *   - **Grains only.** The bulletin also carries «Средни цени на едро на
 *     основни плодове и зеленчуци» in `евро/кг` from the тържища. Not
 *     ingested: per-kg, wholesale, and commodities the vocabulary does not
 *     carry.
 *   - **Bread wheat only.** The table has two wheat rows — «Хлебна пшеница»
 *     and «Фуражна пшеница» — and the natural key has no grade field, so they
 *     would collide on `wheat`. The bread row wins, which also keeps it
 *     comparable with ZarnoBorsa's milling wheat.
 */

/** One bulletin as the listing page advertises it. */
export interface MzhBulletinLink {
    /** The date the page prints beside the link, `YYYY-MM-DD`. */
    date: string;
    /** Site-relative path, exactly as the page gives it. */
    href: string;
}

/** One parsed purchase-price row. */
export interface MzhPriceRow {
    /** The Bulgarian label, verbatim — what the bulletin printed. */
    label: string;
    /** A canonical commodity key. */
    commodity: string;
    /**
     * A DECIMAL STRING, never a number.
     *
     * `MarketPricePoint.price` is `Decimal(12,2)` and the house rule is that
     * money never passes through a binary float. These figures reach the
     * grain calculator, so a rounding nobody asked for would be in money a
     * farmer acts on.
     */
    price: string;
}

/** The whole reading of one bulletin. */
export interface MzhPurchasePrices {
    /** The week-ending date the table is «към», `YYYY-MM-DD`. */
    asOf: string;
    rows: MzhPriceRow[];
    /**
     * Labels the table printed that no rule covers.
     *
     * Reported rather than dropped: a renamed row is the failure mode this
     * parser cannot see any other way, and it would otherwise look exactly
     * like a week when МЗХ published fewer commodities.
     */
    unmappedLabels: string[];
    /** Mapped labels whose current-week figure was «*» — «няма данни». */
    noDataLabels: string[];
}

/**
 * The grain rows we store, keyed by the label the bulletin prints.
 *
 * «Фуражна пшеница» is DELIBERATELY ABSENT and is listed in
 * {@link SKIPPED_LABELS} instead, so a skipped row cannot be confused with an
 * unmapped one. That distinction is the whole reason there are two lists: an
 * unmapped label means the bulletin changed and somebody must look, a skipped
 * label means the owner decided.
 */
export const COMMODITY_BY_LABEL: Readonly<Record<string, string>> = {
    'Хлебна пшеница': 'wheat',
    Ечемик: 'barley',
    Царевица: 'maize',
    Слънчоглед: 'sunflower',
    Рапица: 'rapeseed',
};

/** Rows the bulletin prints that we deliberately do not store, with the reason. */
export const SKIPPED_LABELS: Readonly<Record<string, string>> = {
    'Фуражна пшеница':
        'Owner ruling 2026-11-16 — bread wheat only. The natural key has no grade '
        + 'field, so a second wheat row would collide with `wheat`.',
};

/**
 * `«28.09.2026»` → `2026-09-28`, or null.
 *
 * ROUND-TRIPPED through `Date.UTC` rather than pattern-matched, because a
 * pattern is not a validator: `31.02.2026` matches `DD.MM.YYYY` perfectly and
 * `Date.UTC` rolls it forward to 3 March. Compare the components back.
 */
export function parseBgDate(text: string): string | null {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text.trim());
    if (!m) return null;
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = Number(m[3]);
    const stamp = new Date(Date.UTC(year, month - 1, day));
    if (
        stamp.getUTCFullYear() !== year
        || stamp.getUTCMonth() !== month - 1
        || stamp.getUTCDate() !== day
    ) {
        return null;
    }
    return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Bulletin links from the listing page's HTML, newest first as the page orders
 * them.
 *
 * Deliberately NOT a DOM parse: the page is server-rendered markup whose
 * shape we do not control, and the one thing that identifies a bulletin is the
 * href itself (`operativen_analiz_`) plus a printed date near it. A selector
 * against this site's layout would break on a redesign that left the links
 * perfectly intact.
 *
 * The DATE comes from the filename rather than the surrounding text. The page
 * prints the bulletin date beside the link, but it is the FILENAME that is
 * unambiguous — the directory is the publish date, so reading the path's
 * directory would be a day out most weeks.
 */
export function parseBulletinList(html: string): MzhBulletinLink[] {
    const out: MzhBulletinLink[] = [];
    const seen = new Set<string>();
    const href = /(\/media\/filer_public\/\d{4}\/\d{2}\/\d{2}\/operativen_analiz_(\d{4})-(\d{2})-(\d{2})[^"']*\.pdf)/g;
    let m: RegExpExecArray | null;
    while ((m = href.exec(html)) !== null) {
        const [, path, y, mo, d] = m;
        if (seen.has(path)) continue;
        seen.add(path);
        const date = parseBgDate(`${d}.${mo}.${y}`);
        // A filename whose own date is not a real day is not a bulletin we can
        // place in time, so it is dropped rather than stored under a guess.
        if (date) out.push({ date, href: path });
    }
    return out;
}

/**
 * The grain table's text, from its heading to its source line.
 *
 * Bounded at BOTH ends, and the end bound is the load-bearing one: the fruit
 * and vegetable table that follows has the same row shape — a label then five
 * figures — so an unbounded slice would parse «картофи» at 0,62 евро/кг as a
 * grain price in евро/тон. Returns null when either bound is missing, because
 * a half-found table is the one case where guessing is worse than failing.
 */
export function sliceGrainTable(text: string): string | null {
    const start = text.indexOf('Средни изкупни цени');
    if (start === -1) return null;
    const rest = text.slice(start);
    const end = rest.indexOf('Източник');
    if (end === -1) return null;
    return rest.slice(0, end);
}

/**
 * Read the purchase-price table out of `pdftotext -layout` output.
 *
 * Returns null when the table cannot be found at all. A row that cannot be
 * read is reported in `unmappedLabels` / `noDataLabels` rather than throwing:
 * one reformatted row must not cost the whole week's prices, and a silent drop
 * is what makes a changed bulletin invisible.
 */
export function parsePurchasePrices(text: string): MzhPurchasePrices | null {
    const slice = sliceGrainTable(text);
    if (!slice) return null;

    // «към 30.09.2026 г.» — the week-ENDING date. The figures are weekly
    // averages («средноседмични»), so this is the point date; the publish date
    // is a different fact and is not it.
    const asOfMatch = /към\s+(\d{2}\.\d{2}\.\d{4})/.exec(slice);
    const asOf = asOfMatch ? parseBgDate(asOfMatch[1]) : null;
    if (!asOf) return null;

    const rows: MzhPriceRow[] = [];
    const unmappedLabels: string[] = [];
    const noDataLabels: string[] = [];

    for (const raw of slice.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        // A row is a Cyrillic label followed by its figures. The label may
        // carry spaces and brackets, so it is taken as everything before the
        // first figure-or-asterisk token rather than by word count.
        const m = /^([А-Яа-яЁё][^0-9*]*?)\s{2,}([-0-9*,.\s]+)$/.exec(line);
        if (!m) continue;
        const label = m[1].trim();
        if (label in SKIPPED_LABELS) continue;

        // Five columns: year-ago, previous week, CURRENT, then two % changes.
        // `*` is «няма данни» and `-` stands in for an unprintable change.
        const cells = m[2].trim().split(/\s+/);
        if (cells.length < 3) continue;

        if (!(label in COMMODITY_BY_LABEL)) {
            unmappedLabels.push(label);
            continue;
        }
        const current = cells[2];
        if (current === '*' || current === '-') {
            // «няма данни». NEVER stored as 0 — a zero purchase price renders
            // as a market collapse, which is the one wrong answer worse than
            // no answer.
            noDataLabels.push(label);
            continue;
        }
        // Bulgarian decimal comma → point. The grain figures are whole euros
        // today, but the separator is the source's and not ours to assume.
        const price = current.replace(',', '.');
        if (!/^\d+(?:\.\d+)?$/.test(price)) {
            noDataLabels.push(label);
            continue;
        }
        rows.push({ label, commodity: COMMODITY_BY_LABEL[label], price });
    }

    return { asOf, rows, unmappedLabels, noDataLabels };
}
