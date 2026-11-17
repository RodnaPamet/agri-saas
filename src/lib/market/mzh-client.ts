/**
 * Fetching МЗХ's «Оперативен анализ» and turning its PDF into text (#3136).
 *
 * Two network calls and one subprocess: read the listing page, pick a
 * bulletin, download the PDF, and extract its text with `pdftotext -layout`.
 * The parsing lives in `mzh-parse.ts`, which touches no IO and is tested
 * against a checked-in fixture of the real thing.
 *
 * ## Why `pdftotext` and not a JavaScript PDF library
 *
 * Owner ruling 2026-11-16, against `pdfjs-dist` and against extending the
 * ZarnoBorsa sidecar. `poppler-utils` is a system package in the runtime
 * image and `-layout` is what preserves the table's COLUMNS — which is the
 * whole problem, since the current week's figure is the third of five numbers
 * in a row and column order is the only thing that identifies it. It is also
 * the tool the bulletin was first read with, so the fixture the parser is
 * tested against is byte-identical to what production will see.
 *
 * The cost is honest: a system package, and an apt fetch at image-build time
 * — the dependency class #3001 is open about. It is paid once per image rather
 * than once per run.
 *
 * ## The listing page is not optional
 *
 * URL construction does not work — see `parseBulletinList`. Six measured
 * bulletins disagree on both the directory date and the filename suffix.
 */
import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { parseBulletinList, parsePurchasePrices, type MzhBulletinLink, type MzhPurchasePrices } from './mzh-parse';

const execFileAsync = promisify(execFile);

export const MZH_ORIGIN = 'https://www.mzh.government.bg';

/** The listing page. Paginated with `?page=N`; page 1 carries the newest. */
export const MZH_BULLETIN_INDEX =
    `${MZH_ORIGIN}/bg/ikonomicheski-analizi/tekushi-operativni-analizi-za-osnovni-zemedelski-kulturi/`;

const FETCH_TIMEOUT_MS = 20_000;
/** A bulletin is ~350 KB. The cap refuses a redirect to something else entirely. */
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const PDFTOTEXT_TIMEOUT_MS = 30_000;

export interface MzhFetchOptions {
    /** Injected in tests; defaults to global `fetch`. */
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    /** Injected in tests so no PDF binary or poppler install is needed. */
    extractText?: (pdf: Buffer) => Promise<string>;
}

async function get(url: string, opts: MzhFetchOptions, accept: string): Promise<Response> {
    const doFetch = opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
    let response: Response;
    try {
        response = await doFetch(url, {
            method: 'GET',
            headers: { Accept: accept },
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
    if (!response.ok) {
        throw new Error(`МЗХ ${response.status} for ${url}`);
    }
    return response;
}

/** Every bulletin the index page advertises, newest first as it orders them. */
export async function fetchBulletinIndex(opts: MzhFetchOptions = {}): Promise<MzhBulletinLink[]> {
    const response = await get(MZH_BULLETIN_INDEX, opts, 'text/html');
    return parseBulletinList(await response.text());
}

/**
 * `pdftotext -layout`, through a temp file.
 *
 * Poppler reads stdin with `-`, and this writes a file anyway: a 350 KB pipe
 * is no cheaper, and a path in the error message is what makes a failure
 * diagnosable. The directory is removed in a `finally`, so a throw cannot
 * leave the bulletin on disk.
 */
export async function extractPdfText(pdf: Buffer): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mzh-'));
    const path = join(dir, 'bulletin.pdf');
    try {
        await writeFile(path, pdf);
        const { stdout } = await execFileAsync(
            'pdftotext',
            ['-layout', '-enc', 'UTF-8', path, '-'],
            { timeout: PDFTOTEXT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
        );
        return stdout;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/**
 * Download one bulletin and read its purchase-price table.
 *
 * Returns null when the PDF holds no readable grain table — a bulletin whose
 * shape changed, or a week МЗХ published something else under the same name.
 * The caller reports that rather than treating it as zero prices.
 */
export async function fetchPurchasePrices(
    link: MzhBulletinLink,
    opts: MzhFetchOptions = {},
): Promise<MzhPurchasePrices | null> {
    return parsePurchasePrices(await fetchBulletinText(link, opts));
}

/**
 * A bulletin's extracted text, once — the prices and the campaign progress
 * (#3173) are both read from it, so the PDF is downloaded a single time.
 */
export async function fetchBulletinText(link: MzhBulletinLink, opts: MzhFetchOptions = {}): Promise<string> {
    const url = link.href.startsWith('http') ? link.href : `${MZH_ORIGIN}${link.href}`;
    const response = await get(url, opts, 'application/pdf');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_PDF_BYTES) {
        throw new Error(`МЗХ bulletin at ${url} is ${bytes.byteLength} bytes, over the cap`);
    }
    return (opts.extractText ?? extractPdfText)(bytes);
}
