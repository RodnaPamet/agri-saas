/**
 * Server-authored user-facing copy — the class no i18n guard could see.
 *
 * `no-hardcoded-ui-strings` walks `src/app` and `src/components`. Every
 * message thrown from a usecase lives in `src/app-layer/` or `src/lib/`,
 * so the count could reach 530 without a single test going red — while
 * the repo carried EIGHT green i18n guard files and a key-parity report
 * of `missing 0, drift 0, untranslated 0`.
 *
 * That is the whole reason this file exists: a translation is airtight
 * when adding untranslated text FAILS A TEST, not when the current text
 * happens to be translated. See `docs/i18n-airtight-roadmap.md`.
 *
 * ── What counts ──
 *
 * A message argument to `badRequest` / `notFound` / `forbidden` /
 * `conflict` / `unprocessable` that reads like prose: two or more latin
 * words, and not an ALL-CAPS identifier (`BAD_REQUEST` is a code, not
 * copy). These reach a client — `ApiClientError` preserves `message`,
 * and the iOS app renders the raw envelope, English and all.
 *
 * ── What does NOT count, and why that is the point ──
 *
 * A throw that carries a machine-readable CODE is exempt. A code is what
 * a client can translate; the English beside it becomes the fallback for
 * a code the client does not recognise — exactly the shape
 * `explainRefusal` already ships for the calculator's refusals, and the
 * shape `CLAUDE.md` already mandates for email ("a value shown to a
 * recipient must not be a pre-rendered sentence").
 *
 * **No call site is exempt today** — the helpers take no code parameter
 * yet, which is precisely why all 152 `badRequest` messages share one
 * category code and none of them can be keyed on. The exemption is
 * implemented ahead of that change so the ratchet REWARDS the migration
 * the moment it starts: every throw that gains a code drops out of the
 * count, and the baseline falls with it. Its mechanism is proven below
 * against a synthetic fixture rather than against zero real matches,
 * because an exemption nothing exercises is an exemption nobody can
 * trust.
 */
import * as fs from 'fs';
import * as path from 'path';
import { collectSourceFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const REPO_ROOT = path.resolve(__dirname, '../..');
const ROOTS = ['src/app-layer', 'src/lib'];

/**
 * The helpers whose first argument is shown to a person.
 * `unauthorized` is absent on purpose: its message is never rendered —
 * an unauthenticated client is redirected, not shown prose.
 */
/**
 * Matches the helper and its FIRST string literal directly.
 *
 * An earlier version captured an argument window with `\(([^;]*?)\)` and
 * pulled the message out of it. That window stops at the first `)` — which
 * for `'Only the assigned reviewer (or a tenant admin) may submit…'` lands
 * INSIDE the string, truncating it before its closing quote so the match was
 * dropped entirely. It hid 33 messages, every one of them for the sole
 * reason that it contained a parenthesis.
 *
 * That is the same defect this guard exists to catch, one level up: a scan
 * covering almost the right population reads exactly like one covering all
 * of it. Anchoring on the literal itself has no window to get wrong.
 */
const THROWERS =
    /\b(badRequest|notFound|forbidden|conflict|unprocessable)\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;
/** An ALL-CAPS string literal among the call's OWN arguments = a code. */
const CARRIES_CODE = /(['"`])[A-Z][A-Z0-9_]{3,}\1/;
/** Hard stop, so a malformed file cannot make this scan run away. */
const MAX_ARG_SCAN = 400;


/**
 * The remainder of a call's argument list, from `start` to its matching
 * close paren.
 *
 * This is a balanced scan and not a fixed window, because a fixed window
 * was WRONG in a way worth recording: at 200 characters it ran past the
 * call into the following statements, so any neighbouring quoted ALL-CAPS
 * literal — `code: 'STALE_DATA'`, an enum comparison — exempted a throw
 * that carried no code at all. It silently exempted 66 of them.
 *
 * The comment justifying that window claimed a too-generous one "can only
 * ever EXEMPT a throw that is already coded". That was the error: the
 * exemption keys on a neighbour, so generosity leaks in exactly the
 * direction that hides work. The synthetic fixture at the bottom of this
 * file is what caught it.
 */
function argsAfter(src: string, start: number): string {
    let depth = 1;
    const end = Math.min(src.length, start + MAX_ARG_SCAN);
    for (let i = start; i < end; i++) {
        const c = src[i];
        if (c === '(') depth++;
        else if (c === ')') {
            depth--;
            if (depth === 0) return src.slice(start, i);
        }
    }
    return src.slice(start, end);
}

/**
 * Prose, not an identifier. Two latin words is the floor — it keeps
 * `'Not Found'` in and `'BAD_REQUEST'` out without a word list.
 */
export function looksLikeUserCopy(raw: string): boolean {
    const t = raw.trim();
    if (!t) return false;
    if (/^[A-Z0-9_]+$/.test(t)) return false;
    return (t.match(/[A-Za-z]{2,}/g) ?? []).length >= 2;
}

export interface CopyHit {
    file: string;
    message: string;
}

/**
 * Every user-facing English message thrown under `dirs`, minus coded ones.
 *
 * The file walk is `collectSourceFiles`, not a hand-rolled one. A guard's
 * unit of work is a SELECTION, and an empty selection passes every
 * assertion built on it — a sweep of this repo found 47 of 58 auditable
 * guards dead that way, 37 of them the same gutted `walk`. That helper
 * refuses to return an empty list, which is a stronger guarantee than the
 * positive control below and is why the repo forbids a new hand-rolled
 * collector (`file-collection-is-not-silently-empty`). I wrote one
 * anyway; CI caught it.
 *
 * `floor` is 200 against a real population of 667, so an `exclude`
 * predicate that ate most of the tree fails here rather than reporting a
 * clean repo.
 */
export function collectServerAuthoredCopy(root: string, dirs: string[] = ROOTS): CopyHit[] {
    const files = collectSourceFiles({
        roots: dirs.map((d) => path.join(root, d)),
        extensions: ['.ts'],
        exclude: (rel) => /\.(test|spec)\.ts$/.test(rel),
        floor: root === REPO_ROOT ? 200 : 1,
    });

    const hits: CopyHit[] = [];
    for (const full of files) {
        // Comments blanked, positions intact (#1387). STRINGS ARE KEPT:
        // the message text is this guard's entire subject, so blanking
        // string literals would blind it rather than sharpen it.
        const src = blankNonCode(fs.readFileSync(full, 'utf8'));
        for (const call of src.matchAll(THROWERS)) {
            const message = call[3];
            if (!looksLikeUserCopy(message)) continue;
            const afterMessage = (call.index ?? 0) + call[0].length;
            if (CARRIES_CODE.test(argsAfter(src, afterMessage))) continue; // coded — exempt
            hits.push({ file: path.relative(root, full), message });
        }
    }
    return hits;
}

/**
 * Measured 2026-09-22. MAY ONLY FALL.
 *
 * Lower it in the same diff that drains it — the drift sentinel below
 * forbids leaving slack, so this tracks reality rather than headroom.
 *
 * Note this is 530 where `docs/i18n-airtight-roadmap.md` first said 382:
 * that earlier figure came from a narrower grep requiring a capital
 * first letter and 15+ characters. Both were honest for their own
 * definition; this one is the definition that is now ENFORCED, so it is
 * the number that means something.
 *
 * 530 → 502: batch two coded the journal (the legally-filed register) and
 * field-operation (the spray recording that fills it). 29 call sites gained
 * a code and the count fell by 28 — the 29th is a ternary message, which
 * `THROWERS` never matched, so it was drained without ever being counted.
 * That gap is worth knowing: the ratchet measures literal-message throws,
 * so a computed message is user-facing English it cannot see.
 *
 * 502 → 497: no message was drained. #1387 taught the scan to skip COMMENTS,
 * and five of the 502 were prose quoting a throw rather than a throw —
 * `permission-middleware` twice, `stock-ledger` once, and `ai/budget` twice.
 * Lowered here rather than left as slack precisely because it is not
 * progress: leaving it would buy five real messages' worth of headroom for
 * nothing, which is what the drift sentinel below exists to prevent.
 */
const CURRENT_BASELINE = 492;

/** Slack tolerated before the sentinel demands the baseline be lowered. */
const DRIFT_ALLOWANCE = 15;

describe('server-authored user-facing copy stays on a downward ratchet', () => {
    const hits = collectServerAuthoredCopy(REPO_ROOT);

    it(`stays at or below ${CURRENT_BASELINE}`, () => {
        if (hits.length > CURRENT_BASELINE) {
            const sample = hits
                .slice(0, 15)
                .map((h) => `  ${h.file}  "${h.message}"`)
                .join('\n');
            throw new Error(
                `Server-authored user-facing copy rose to ${hits.length} ` +
                    `(baseline ${CURRENT_BASELINE}).\n\n${sample}\n\n` +
                    `A message thrown from src/app-layer or src/lib reaches a ` +
                    `Bulgarian operator in English — the web preserves it on ` +
                    `ApiClientError, and the iOS app renders the raw envelope.\n` +
                    `Give the throw a machine-readable CODE so a client can ` +
                    `translate it, keeping the English as the fallback. See ` +
                    `docs/i18n-airtight-roadmap.md.`,
            );
        }
        expect(hits.length).toBeLessThanOrEqual(CURRENT_BASELINE);
    });

    it('the baseline tracks reality — no accumulated slack', () => {
        // Without this, every drained message silently buys headroom for a
        // new one and the ratchet stops ratcheting.
        expect(CURRENT_BASELINE).toBeLessThanOrEqual(hits.length + DRIFT_ALLOWANCE);
    });

    it('the scan actually reaches the server layer (positive control)', () => {
        // An empty selection satisfies a ceiling. If the walk breaks, or
        // the roots move, this is what says so instead of a green zero.
        expect(hits.length).toBeGreaterThan(0);
        expect(new Set(hits.map((h) => h.file)).size).toBeGreaterThan(20);
    });
});

describe('the counting rule itself', () => {
    it('prose counts; an ALL-CAPS identifier does not', () => {
        expect(looksLikeUserCopy('Access review not found')).toBe(true);
        expect(looksLikeUserCopy('Not Found')).toBe(true);
        expect(looksLikeUserCopy('BAD_REQUEST')).toBe(false);
        expect(looksLikeUserCopy('NOT_FOUND')).toBe(false);
        expect(looksLikeUserCopy('')).toBe(false);
    });

    it('prose ABOUT a throw is not a throw (#1387)', () => {
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'i18n-cmt-'));
        try {
            fs.mkdirSync(path.join(dir, 'src/lib'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'src/lib/sample.ts'),
                [
                    `// Denials throw badRequest('A fertilizer dose is required.') so the`,
                    `// caller can translate it. Quoted here, not called.`,
                    `/**`,
                    ` * Also throws notFound('The parcel has no soil sample.') in prose.`,
                    ` */`,
                    `throw conflict('The lot is already closed.');`,
                ].join('\n'),
                'utf8',
            );
            const found = collectServerAuthoredCopy(dir, ['src/lib']);
            // Exactly the one real throw. Before #1387 this was three.
            expect(found.map((h) => h.message)).toEqual(['The lot is already closed.']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a message CONTAINING `//` survives, and a `//` line holding `/*` eats nothing', () => {
        // Two traps the stripper has to miss, and both are cheap to get
        // wrong. Truncating at a `//` inside a string would blank real
        // arguments and UNDER-count — the direction that hides work. And a
        // line comment that happens to contain `/*` must not open a block
        // comment: blanking blocks before lines made exactly that mistake
        // elsewhere in this repo and silently swallowed ten declarations.
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'i18n-str-'));
        try {
            fs.mkdirSync(path.join(dir, 'src/lib'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'src/lib/sample.ts'),
                [
                    `throw badRequest('See https://agrent.bg/help for guidance.');`,
                    `// a path like deploy/rollback/*.down.sql must not open a comment`,
                    `throw forbidden('This farm is not yours to edit.');`,
                ].join('\n'),
                'utf8',
            );
            const found = collectServerAuthoredCopy(dir, ['src/lib']);
            expect(found.map((h) => h.message)).toEqual([
                'See https://agrent.bg/help for guidance.',
                'This farm is not yours to edit.',
            ]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a CODED throw is exempt, an uncoded one is not', () => {
        // The exemption has no real call sites yet — the helpers take no
        // code parameter — so it is proven here or not at all. When the
        // parameter lands, this is the behaviour the migration relies on.
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'i18n-copy-'));
        try {
            fs.mkdirSync(path.join(dir, 'src/lib'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'src/lib/sample.ts'),
                [
                    `throw badRequest('A fertilizer dose is required.');`,
                    `throw badRequest('A fertilizer dose is required.', 'DOSE_REQUIRED');`,
                    `throw notFound('BAD_REQUEST');`,
                ].join('\n'),
            );
            const found = collectServerAuthoredCopy(dir, ['src/lib']);
            expect(found).toHaveLength(1);
            expect(found[0].message).toBe('A fertilizer dose is required.');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
