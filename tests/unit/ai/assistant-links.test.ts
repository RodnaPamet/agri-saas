/**
 * Links are built by the SERVER from what it read — #2578.
 *
 * The property that matters: a link cannot name a record the turn did not
 * read, because the only material it is built from is the tool results. There
 * is no fabricated id to catch, so these tests are about the shape rules and
 * the one new egress door — a link LABEL comes from a farm record's own field,
 * so it is outgoing text by the same route the answer is.
 */
import {
    linksFromRows,
    linkTemplateIsReal,
    mergeLinks,
    MAX_LABEL_CHARS,
    MAX_LINKS,
} from '@/app-layer/ai/assistant/links';

const SHAPE = { template: '/farm-tasks/[taskId]', idField: 'id', labelField: 'title' };
const row = (id: string, title = 'Пръскане') => ({ id, title });

describe('assistant links (#2578)', () => {
    it('a declared template must name a REAL screen', () => {
        expect(linkTemplateIsReal('/farm-tasks/[taskId]')).toBe(true);
        // Not a screen this app serves — a link here would 404 on a phone.
        expect(linkTemplateIsReal('/nope/[id]')).toBe(false);
        // The prefix is restored internally, so a client-shaped path is not
        // accidentally accepted.
        expect(linkTemplateIsReal('/t/[tenantSlug]/farm-tasks/[taskId]')).toBe(false);
    });

    it('builds a CONCRETE, tenant-relative route', () => {
        expect(linksFromRows(SHAPE, [row('abc123')])).toEqual([
            { route: '/farm-tasks/abc123', label: 'Пръскане' },
        ]);
    });

    it('refuses an id that is not an id — no path segment can ride in', () => {
        for (const bad of ['../../etc/passwd', 'a/b', 'a?x=1', 'a b', '', 'x'.repeat(65)]) {
            expect(linksFromRows(SHAPE, [row(bad)])).toEqual([]);
        }
    });

    it('skips a row with no usable label rather than linking it blankly', () => {
        expect(linksFromRows(SHAPE, [{ id: 'a1' }, { id: 'a2', title: '   ' }])).toEqual([]);
    });

    it('truncates a long label instead of dropping the link', () => {
        const [link] = linksFromRows(SHAPE, [row('a1', 'я'.repeat(200))]);
        expect(link.label.length).toBe(MAX_LABEL_CHARS);
        expect(link.route).toBe('/farm-tasks/a1');
    });

    it('returns nothing for an unreal template, rather than a 404 link', () => {
        expect(linksFromRows({ ...SHAPE, template: '/nope/[id]' }, [row('a1')])).toEqual([]);
    });

    it('returns nothing when the template has no single record parameter', () => {
        // `/farm-tasks` has none; a two-parameter template is ambiguous.
        expect(linksFromRows({ ...SHAPE, template: '/farm-tasks' }, [row('a1')])).toEqual([]);
    });

    it('tolerates a non-array, and rows that are not objects', () => {
        for (const junk of [null, undefined, 'x', 42, {}]) {
            expect(linksFromRows(SHAPE, junk)).toEqual([]);
        }
        expect(linksFromRows(SHAPE, [null, 'x', 42, row('a1')])).toEqual([
            { route: '/farm-tasks/a1', label: 'Пръскане' },
        ]);
    });

    it('de-duplicates by ROUTE, then caps — so the cap counts destinations', () => {
        const a = linksFromRows(SHAPE, [row('a1'), row('a2')]);
        const again = linksFromRows(SHAPE, [row('a1'), row('a3')]);
        const merged = mergeLinks([a, again]);
        expect(merged.map((l) => l.route)).toEqual([
            '/farm-tasks/a1',
            '/farm-tasks/a2',
            '/farm-tasks/a3',
        ]);
        const many = linksFromRows(
            SHAPE,
            Array.from({ length: MAX_LINKS + 4 }, (_, i) => row(`id${i}`)),
        );
        expect(mergeLinks([many])).toHaveLength(MAX_LINKS);
    });
});
