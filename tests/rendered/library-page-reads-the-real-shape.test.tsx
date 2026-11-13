/**
 * «Вдъхновение» — the two library clients, EXECUTED (#2980 PR 3).
 *
 * ## Why this file exists rather than a guard
 *
 * The other backend session put it plainly while the page was being written:
 * two books are live in production, the flag is on, the surface is
 * session-gated, and this page is the FIRST thing that exercises the read path
 * with a real session. Their data is verified (13 and 6 chapters, 74 and 21
 * paragraphs), so if the page renders nothing the fault is on this side.
 *
 * A guard cannot find that fault. Every field name here is a string the
 * compiler never checks against the route's actual response — the API's own
 * lesson, from #2980's directory read: five `select` keys were wrong, typed
 * clean, and failed at runtime. A component reading `book.name` instead of
 * `book.title` renders an empty row and throws nothing, which is
 * indistinguishable from "no books published yet".
 *
 * ## The SWR KEY is asserted as a literal, and that is the offline contract
 *
 * `PERSISTABLE_PATHS` holds `/api/library/books`, and `tenantRelativePath`
 * hands a non-tenant key back unchanged — so the key has to be that string
 * EXACTLY or nothing is written to disk. Nothing else observes that: the page
 * works perfectly in a browser with a network while persisting nothing, and
 * the failure only appears on a phone in a field. So the key is pinned here,
 * for both reads, including that the reader's key sits UNDER the directory's
 * so the list matcher (`startsWith(p + '/')`) covers the book text.
 *
 * ## An error with cached books must NOT blank them
 *
 * `isError && books.length === 0` is Epic 53's rule, and it matters more on
 * this surface than on a farm list: being offline is the EXPECTED state for a
 * library, so a failed revalidation beside a cached book is the normal case,
 * not an exception. Asserted in both directions, because "render the error"
 * and "render the error only when there is nothing to show" look identical
 * until there is something to show.
 *
 * ## The absence of `lang` is pinned on purpose
 *
 * `originalTitle` carries no `lang` attribute. The first draft had
 * `lang="zh-Hant"`, which is right for Sun Tzu and wrong for Franklin, and the
 * payload has no field to derive it from (#3036). Pinning the ABSENCE is what
 * stops somebody re-adding a hardcoded one: a wrong `lang` makes a screen
 * reader pronounce English with Chinese phonetics, which is worse than the
 * fallback.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';

import { restoreViewport, setViewport } from './viewport';

/**
 * The double RETURNS THE NAMESPACED KEY, unlike the sibling suites.
 *
 * They return the bare key, which is fine where the keys are long. Here the
 * two that matter are `empty` and `error`, and a bare `error` substring-matches
 * plenty of innocent output — so an assertion that an empty library does NOT
 * show the error state could pass or fail for the wrong reason. Carrying the
 * namespace the component asked for makes `library.empty` and `library.error`
 * unambiguous, and it is also what `useTranslations('library')` really does.
 */
jest.mock('next-intl', () => ({
    useTranslations: (ns?: string) => {
        const t = (key: string) => (ns ? `${ns}.${key}` : key);
        (t as unknown as { rich: (k: string) => string }).rich = t;
        return t;
    },
    useLocale: () => 'bg',
}));

const apiGet = jest.fn();
jest.mock('@/lib/api-client', () => ({
    apiGet: (...a: unknown[]) => apiGet(...a),
}));

const plainSwr = jest.fn();
jest.mock('swr', () => ({
    __esModule: true,
    default: (...a: unknown[]) => plainSwr(...a),
}));

import { LibraryDirectoryClient } from '@/app/library/LibraryDirectoryClient';
import { BookReaderClient } from '@/app/library/[slug]/BookReaderClient';

/** The directory payload, in the shape `GET /api/library/books` really returns. */
const BOOKS = {
    books: [
        {
            slug: 'sun-tzu-izkustvoto-na-voynata',
            title: 'Изкуството на войната',
            author: 'Сун Дзъ',
            summary: 'Тринадесет глави за стратегия.',
        },
        {
            slug: 'franklin-patyat-kam-bogatstvoto',
            title: 'Пътят към богатството',
            author: 'Бенджамин Франклин',
            summary: null,
        },
    ],
};

/** The detail payload — the BOOK itself, not `{ book }`. */
const BOOK = {
    slug: 'sun-tzu-izkustvoto-na-voynata',
    title: 'Изкуството на войната',
    author: 'Сун Дзъ',
    locale: 'bg',
    summary: 'Тринадесет глави.',
    sourceNote: 'Публично достояние.',
    licenseNote: 'CC0',
    chapters: [
        {
            number: 1,
            title: 'Предварителни разчети',
            originalTitle: '始計',
            paragraphs: ['Войната е от жизнено значение за държавата.', 'Затова я изучавай.'],
        },
        {
            number: 2,
            title: 'Водене на войната',
            originalTitle: null,
            paragraphs: ['Бързината е същността на войната.'],
        },
    ],
};

function swr(result: Record<string, unknown>): void {
    plainSwr.mockImplementation(() => result);
}

beforeEach(() => {
    jest.clearAllMocks();
    plainSwr.mockReset();
    setViewport('mobile');
});

afterEach(restoreViewport);

describe('the library directory', () => {
    it('fetches the EXACT key the offline allowlist holds', () => {
        swr({ data: BOOKS, isLoading: false, error: undefined });
        render(<LibraryDirectoryClient />);

        // Not `toContain`, not a regex: `PERSISTABLE_PATHS` matches this
        // string, and a helper-built or query-carrying key persists nothing
        // while looking identical in a browser.
        expect(plainSwr.mock.calls[0][0]).toBe('/api/library/books');
    });

    it('renders the fields the route actually returns', () => {
        swr({ data: BOOKS, isLoading: false, error: undefined });
        render(<LibraryDirectoryClient />);

        expect(screen.getByText('Изкуството на войната')).toBeInTheDocument();
        expect(screen.getByText('Сун Дзъ')).toBeInTheDocument();
        expect(screen.getByText('Тринадесет глави за стратегия.')).toBeInTheDocument();
        // The second book has no summary — an absent one renders nothing
        // rather than the word "null", which is what a bare `{book.summary}`
        // would have produced had the field been optional-but-rendered.
        expect(screen.queryByText('null')).not.toBeInTheDocument();
        expect(screen.getByText('Пътят към богатството')).toBeInTheDocument();
    });

    it('links each book to its reader', () => {
        swr({ data: BOOKS, isLoading: false, error: undefined });
        render(<LibraryDirectoryClient />);

        expect(
            screen.getByRole('link', { name: /Изкуството на войната/ }),
        ).toHaveAttribute('href', '/library/sun-tzu-izkustvoto-na-voynata');
    });

    it('tells an EMPTY library from a FAILED read', () => {
        swr({ data: { books: [] }, isLoading: false, error: undefined });
        const empty = render(<LibraryDirectoryClient />);
        expect(empty.container.textContent).toContain('library.empty');
        expect(empty.container.textContent).not.toContain('library.error');
        empty.unmount();

        swr({ data: undefined, isLoading: false, error: new Error('offline') });
        const failed = render(<LibraryDirectoryClient />);
        expect(failed.container.textContent).toContain('library.error');
        expect(failed.container.textContent).not.toContain('library.empty');
    });

    it('KEEPS cached books when a revalidation fails', () => {
        // The case that matters offline, and the one a naive `if (error)`
        // gets wrong: there IS something to show, so the error must not
        // replace it.
        swr({ data: BOOKS, isLoading: false, error: new Error('offline') });
        render(<LibraryDirectoryClient />);

        expect(screen.getByText('Изкуството на войната')).toBeInTheDocument();
        expect(screen.queryByText('library.error')).not.toBeInTheDocument();
    });
});

describe('the book reader', () => {
    it('fetches a key UNDER the allowlisted prefix', () => {
        swr({ data: BOOK, isLoading: false, error: undefined });
        render(<BookReaderClient slug="sun-tzu-izkustvoto-na-voynata" />);

        const key = plainSwr.mock.calls[0][0] as string;
        expect(key).toBe('/api/library/books/sun-tzu-izkustvoto-na-voynata');
        // The allowlist matcher is `path === p || path.startsWith(p + '/')`,
        // so this is what makes ONE entry cover the book text as well as the
        // directory. Asserted as the prefix relationship rather than restated
        // as a second literal.
        expect(key.startsWith('/api/library/books/')).toBe(true);
    });

    it('renders chapters, paragraphs and the attribution', () => {
        swr({ data: BOOK, isLoading: false, error: undefined });
        render(<BookReaderClient slug="sun-tzu-izkustvoto-na-voynata" />);

        expect(screen.getByText('Предварителни разчети', { exact: false })).toBeInTheDocument();
        expect(
            screen.getByText('Войната е от жизнено значение за държавата.'),
        ).toBeInTheDocument();
        expect(screen.getByText('Бързината е същността на войната.')).toBeInTheDocument();
        // `sourceNote` and `licenseNote` are not decoration: these are
        // public-domain texts and the attribution is the condition of
        // publishing them.
        expect(screen.getByText(/Публично достояние\./)).toBeInTheDocument();
        expect(screen.getByText(/CC0/)).toBeInTheDocument();
    });

    it('shows an original title where there is one, and no `lang` attribute', () => {
        swr({ data: BOOK, isLoading: false, error: undefined });
        const { container } = render(
            <BookReaderClient slug="sun-tzu-izkustvoto-na-voynata" />,
        );

        const original = screen.getByText('始計');
        expect(original).toBeInTheDocument();
        // #3036. A hardcoded `lang` is right for one published book and wrong
        // for the other, and the payload cannot tell them apart.
        expect(original).not.toHaveAttribute('lang');
        expect(container.querySelector('[lang]')).toBeNull();
    });

    it('renders nothing extra for a chapter with no original title', () => {
        swr({ data: BOOK, isLoading: false, error: undefined });
        render(<BookReaderClient slug="sun-tzu-izkustvoto-na-voynata" />);

        // Chapter 2 has `originalTitle: null`. The heading must be the title
        // alone — a bare `{chapter.originalTitle}` would print nothing, but a
        // wrapper rendered unconditionally would leave an empty element whose
        // spacing shows.
        expect(screen.getByText('Водене на войната', { exact: false })).toBeInTheDocument();
        expect(screen.queryByText('null')).not.toBeInTheDocument();
    });
});
