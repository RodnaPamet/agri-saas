/**
 * Unit — RSS 2.0 / Atom feed parser (`parseFeedXml`).
 *
 * Verifies the pure parse: correct field extraction for both feed dialects,
 * empty-<description> tolerance, http-link tolerance, image extraction, date
 * parsing, and that a malformed document yields an empty item list instead of
 * throwing (per-feed error isolation depends on this).
 */
import { parseFeedXml } from '@/lib/market/news-feed-client';

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>АГРО.БГ</title>
    <link>https://www.agro.bg</link>
    <item>
      <title>Пшеницата поскъпва</title>
      <link>http://www.agro.bg/article/1</link>
      <description>Кратко резюме на новината.</description>
      <category>Новини</category>
      <pubDate>Tue, 14 Jul 2026 16:54:00 +0300</pubDate>
      <enclosure url="http://www.agro.bg/img/1.webp" type="image/webp" length="8374" />
    </item>
    <item>
      <title>Втора новина без описание</title>
      <link>https://www.agro.bg/article/2</link>
      <description></description>
      <pubDate>Mon, 13 Jul 2026 08:00:00 +0300</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Agrozona.bg</title>
  <entry>
    <title>Субсидиите стартират</title>
    <link rel="alternate" href="https://agrozona.bg/news/1" />
    <link rel="enclosure" type="image/jpeg" href="https://agrozona.bg/img/1.jpg" />
    <summary>Резюме от Atom емисия.</summary>
    <updated>2026-07-14T13:00:00Z</updated>
    <published>2026-07-14T12:00:00Z</published>
  </entry>
</feed>`;

describe('parseFeedXml — RSS 2.0', () => {
    it('extracts title, link, description, image, and pubDate', () => {
        const feed = parseFeedXml(RSS2);
        expect(feed.sourceLabel).toBe('АГРО.БГ');
        expect(feed.items).toHaveLength(2);

        const [first] = feed.items;
        expect(first.title).toBe('Пшеницата поскъпва');
        expect(first.url).toBe('http://www.agro.bg/article/1');
        expect(first.snippet).toBe('Кратко резюме на новината.');
        expect(first.imageUrl).toBe('http://www.agro.bg/img/1.webp');
        expect(first.publishedAt).toBeInstanceOf(Date);
        expect(first.publishedAt?.getUTCFullYear()).toBe(2026);
    });

    it('tolerates an empty <description> and a missing image', () => {
        const feed = parseFeedXml(RSS2);
        const second = feed.items[1];
        expect(second.snippet).toBe('');
        expect(second.imageUrl).toBeNull();
        expect(second.url).toBe('https://www.agro.bg/article/2');
    });
});

describe('parseFeedXml — Atom', () => {
    it('extracts title, alternate link, summary, image, and date', () => {
        const feed = parseFeedXml(ATOM);
        expect(feed.sourceLabel).toBe('Agrozona.bg');
        expect(feed.items).toHaveLength(1);

        const [only] = feed.items;
        expect(only.title).toBe('Субсидиите стартират');
        expect(only.url).toBe('https://agrozona.bg/news/1');
        expect(only.snippet).toBe('Резюме от Atom емисия.');
        expect(only.imageUrl).toBe('https://agrozona.bg/img/1.jpg');
        expect(only.publishedAt).toBeInstanceOf(Date);
    });
});

describe('parseFeedXml — malformed / empty', () => {
    it('returns an empty item list for garbage input (no throw)', () => {
        expect(parseFeedXml('not xml at all <<<')).toEqual({
            sourceLabel: '',
            items: [],
        });
    });

    it('returns an empty item list for a feed with no items/entries', () => {
        const empty = `<?xml version="1.0"?><rss version="2.0"><channel><title>X</title></channel></rss>`;
        const feed = parseFeedXml(empty);
        expect(feed.items).toEqual([]);
    });

    it('skips items missing a link or title', () => {
        const partial = `<?xml version="1.0"?><rss version="2.0"><channel><title>X</title>
          <item><title>No link here</title></item>
          <item><link>https://x/1</link></item>
        </channel></rss>`;
        expect(parseFeedXml(partial).items).toHaveLength(0);
    });
});
