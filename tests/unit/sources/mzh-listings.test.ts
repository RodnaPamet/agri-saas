/**
 * МЗХ listing pages → documents — agri-saas#3146, second slice. Synthetic
 * pages in МЗХ's shape (link markup measured on the live site 2026-11-17).
 */
import { listNewsItems, listPdfLinks, MZH_BASE, newsSeries } from '@/lib/sources/mzh-listings';

const PAGE = `${MZH_BASE}/bg/sektori/rastenievadstvo/tehnologichni-karti/`;

describe('listPdfLinks', () => {
    it('resolves each PDF once, with its link text', () => {
        const html = `
            <a href="/media/filer_public/2026/09/01/tk_vineni_lozia.pdf">Заповед за утвърждаване на технологични карти &laquo;Винени&raquo;</a>
            <a class="x" href="/media/filer_public/2026/09/01/tk_vineni_lozia.pdf"><span>дубликат</span></a>
            <a href="https://www.mzh.government.bg/media/filer_public/2025/01/24/karta.pdf"><b>Школувани</b> дървета</a>
            <a href="https://example.org/other.pdf">чужд сайт</a>
            <a href="/bg/sektori/">не е PDF</a>`;
        expect(listPdfLinks(html, PAGE)).toEqual([
            {
                url: `${MZH_BASE}/media/filer_public/2026/09/01/tk_vineni_lozia.pdf`,
                title: 'Заповед за утвърждаване на технологични карти «Винени»',
            },
            { url: `${MZH_BASE}/media/filer_public/2025/01/24/karta.pdf`, title: 'Школувани дървета' },
        ]);
    });

    it('a link with no text keeps the document, without a title', () => {
        expect(listPdfLinks('<a href="/media/a.pdf"><img src="x.png"></a>', PAGE)).toEqual([
            { url: `${MZH_BASE}/media/a.pdf`, title: null },
        ]);
    });

    it('a page in another shape parses to nothing — the job reads that as a fault', () => {
        expect(listPdfLinks('<div>Няма документи</div>', PAGE)).toEqual([]);
    });
});

describe('listNewsItems and newsSeries', () => {
    const NEWS = `${MZH_BASE}/bg/press-center/novini/`;
    const html = `
        <a href="/bg/press-center/novini/opredeleni-sa-stavkite-za-obvrzanoto-2025/"><img src="a.jpg"></a>
        <a href="/bg/press-center/novini/opredeleni-sa-stavkite-za-obvrzanoto-2025/">Определени са ставките за обвързаното подпомагане за плодове и зеленчуци за Кампания 2025</a>
        <a href="/bg/press-center/novini/opredelena-e-stavkata-ovce/">Определена е ставката за преходната национална помощ за овце-майки и кози-майки</a>
        <a href="/bg/press-center/novini/novo-rkovodstvo/">МЗХ публикува Ръководство за интегрирано производство на зеленчуци</a>
        <a href="/bg/press-center/novini/ministr/">Министър: разговор за бъдещето на ОСП</a>`;

    it('reads each item once, keeping the titled link', () => {
        const items = listNewsItems(html, NEWS);
        expect(items).toHaveLength(4);
        expect(items[0]?.title).toMatch(/^Определени са ставките/);
    });

    it('a coupled-support order needs BOTH «ставк» and «обвърза»', () => {
        const titles = listNewsItems(html, NEWS).map((i) => [i.title ?? '', newsSeries(i.title ?? '')]);
        expect(titles).toEqual([
            [expect.stringMatching(/ставките/), 'coupled-support'],
            // The national aid for sheep names a rate and is not an order of this series.
            [expect.stringMatching(/овце-майки/), null],
            [expect.stringMatching(/Ръководство/), 'integrated-production'],
            [expect.stringMatching(/ОСП/), null],
        ]);
    });
});
