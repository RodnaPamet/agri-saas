/**
 * The catalogue and the tagger must describe the same vocabulary.
 *
 * ## The defect this prevents
 *
 * `deriveTags` emits tags from `CROP_TAGS` and `TOPIC_STEMS`. The catalogue
 * endpoint hands clients a label for each one. Those are two lists, and the
 * contract this implements is explicit about what happens to two lists:
 *
 *   "a parallel list would drift from the search vocabulary... adding a crop
 *    would mean editing two lists and the next person would update one."
 *
 * Drift has an asymmetric cost, which is why both directions are checked:
 *
 *   · a tag with NO label renders as a raw slug in the «Предпочитания» sheet.
 *     It looks like a missing translation, so it gets diagnosed on the phone,
 *     by whoever owns the client, days later.
 *   · a label with NO tag is a chip that can never match an article. The
 *     reader taps «Пазар», sees an empty feed, and concludes the feature is
 *     broken rather than that the tag is dead.
 *
 * Neither fails any existing test, and neither is visible in review — the two
 * declarations sit in different files.
 *
 * ## Why this is not a snapshot
 *
 * A snapshot of the catalogue would also fail when the vocabulary changes,
 * which is the one time it SHOULD change. These assertions fail only on
 * disagreement, so adding a tag plus its label is a green diff and adding
 * either alone is red.
 */
import {
    newsTagCatalogue,
    tagsMissingALabel,
    labelsWithoutATag,
} from '@/lib/news/tag-catalogue';
import { CROP_TAGS, TOPIC_TAGS, ALL_NEWS_TAGS, deriveTags } from '@/lib/news/categorize';

describe('the news tag catalogue agrees with the tagger', () => {
    it('every tag the tagger can emit has a label', () => {
        // The failure names the tag rather than a count, because "expected 7
        // to be 6" sends you looking for the wrong thing.
        expect(tagsMissingALabel()).toEqual([]);
    });

    it('every label has a tag behind it', () => {
        expect(labelsWithoutATag()).toEqual([]);
    });

    it('control: the checks can actually fail', () => {
        // Both assertions above pass trivially if the vocabulary is empty or
        // the helpers read the wrong thing. This pins that they are reading a
        // real, populated vocabulary — otherwise two green tests would be
        // guarding nothing at all.
        expect(CROP_TAGS.length).toBe(5);
        expect(TOPIC_TAGS.length).toBeGreaterThanOrEqual(7);
        expect(ALL_NEWS_TAGS.length).toBe(CROP_TAGS.length + TOPIC_TAGS.length);
    });
});

describe('the catalogue has the shape agrent-ios decodes', () => {
    it('is exactly two groups, crops then topics', () => {
        // agrent-ios decodes `{groups:[{key,label,labelEn,tags:[...]}]}` and
        // said plainly that flattening the groups would break the decoder.
        // This is the assertion that stops someone "simplifying" it.
        const { groups } = newsTagCatalogue();

        expect(groups.map((g) => g.key)).toEqual(['crops', 'topics']);
    });

    it('every group and every tag carries both labels, non-empty', () => {
        for (const group of newsTagCatalogue().groups) {
            expect(group.label.length).toBeGreaterThan(0);
            expect(group.labelEn.length).toBeGreaterThan(0);
            expect(group.tags.length).toBeGreaterThan(0);
            for (const tag of group.tags) {
                expect(tag.key).toMatch(/^[a-z-]+$/);
                expect(tag.label.length).toBeGreaterThan(0);
                expect(tag.labelEn.length).toBeGreaterThan(0);
            }
        }
    });

    it('the Bulgarian label is Cyrillic and the English one is not', () => {
        // The two fields are easy to transpose, and a transposition is
        // invisible to every other assertion here — both would still be
        // non-empty strings. It would surface as English labels in the sheet
        // and Bulgarian ones in Voice Control.
        for (const group of newsTagCatalogue().groups) {
            for (const tag of group.tags) {
                expect(tag.label).toMatch(/\p{Script=Cyrillic}/u);
                expect(tag.labelEn).not.toMatch(/\p{Script=Cyrillic}/u);
            }
        }
    });

    it('the keys are the vocabulary, with nothing extra and nothing missing', () => {
        const fromCatalogue = newsTagCatalogue()
            .groups.flatMap((g) => g.tags.map((t) => t.key))
            .sort();

        expect(fromCatalogue).toEqual([...ALL_NEWS_TAGS].sort());
    });
});

describe('«Пазар» is in the catalogue and the tagger emits it', () => {
    it('the owner-confirmed topic is present, labelled «Пазар»', () => {
        const topics = newsTagCatalogue().groups.find((g) => g.key === 'topics');
        const trade = topics?.tags.find((t) => t.key === 'trade');

        expect(trade).toEqual({ key: 'trade', label: 'Пазар', labelEn: 'Market' });
    });

    it('is NOT slugged `market`, which is already a category', () => {
        // `NEWS_CATEGORIES` contains 'market'. A tag of the same name would
        // make `?category=market` and `?tags=market` two different filters
        // sharing one word — the kind of ambiguity that produces a client bug
        // nobody can see in either codebase.
        expect(ALL_NEWS_TAGS).not.toContain('market');
        expect(ALL_NEWS_TAGS).toContain('trade');
    });

    it('a market story gets it, and three false friends do not', () => {
        // Each of these fired during development and each is a Bulgarian word
        // that merely begins like a trade word. They are kept as cases because
        // the stems are a prefix match, so any future widening — including the
        // `stemOf` trap noted in `categorize.ts` — reopens exactly these.
        expect(deriveTags('Пазарът на пшеница се възстановява', null)).toContain('trade');
        expect(deriveTags('Износът на царевица към Румъния расте', null)).toContain('trade');

        expect(deriveTags('Износването на гумите на трактора', null)).not.toContain('trade');
        expect(deriveTags('Вноската по кредита е платена', null)).not.toContain('trade');
        expect(deriveTags('Търг за ремонт на пътя', null)).not.toContain('trade');
    });

    it('covers the four things the owner defined it as', () => {
        // Owner, 2026-10-09: «Пазар» is for "harvest, export, import and yield
        // news". An earlier version of this list had `реколта` REMOVED, on my
        // reasoning that a harvest is production rather than market. That was
        // an inference about what the topic meant, made against the person who
        // defined it, and it was wrong — in a commodity feed supply IS the
        // market story, because a harvest figure is why a price moves.
        //
        // One case per word of the definition, so dropping any one of them
        // again is a red test rather than a silent narrowing.
        expect(deriveTags('Реколтата от слънчоглед е прибрана', null)).toContain('trade');
        expect(deriveTags('Добивите от пшеница са по-високи', null)).toContain('trade');
        expect(deriveTags('Износът на царевица расте', null)).toContain('trade');
        expect(deriveTags('Вносът на торове е спрян', null)).toContain('trade');
    });

    it('«добив» (yield) does not leak into livestock via «добитък»', () => {
        // The two words diverge at the fifth character — добиВ against добиТък
        // — so a prefix matcher keeps them apart. Checked rather than assumed,
        // because a yield story silently tagged `livestock` would be invisible
        // to everything else here.
        const yieldStory = deriveTags('Добивите от пшеница са по-високи', null);

        expect(yieldStory).toContain('trade');
        expect(yieldStory).not.toContain('livestock');
    });

    it('«борса» stays a price story and does not become a trade story', () => {
        // A deliberate boundary: `борса` names the commodity exchange, which
        // is a price surface in this product. Duplicating it into `trade`
        // would make every quote story a trade story too.
        const tags = deriveTags('Цените на борсата паднаха', null);

        expect(tags).toContain('prices');
        expect(tags).not.toContain('trade');
    });
});
