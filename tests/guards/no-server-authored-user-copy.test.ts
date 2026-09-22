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

/** Every user-facing English message thrown under `root`, minus coded ones. */
export function collectServerAuthoredCopy(root: string, dirs: string[] = ROOTS): CopyHit[] {
    const hits: CopyHit[] = [];
    const walk = (dir: string): void => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!/\.ts$/.test(entry.name) || /\.(test|spec)\.ts$/.test(entry.name)) continue;
            const src = fs.readFileSync(full, 'utf8');
            for (const call of src.matchAll(THROWERS)) {
                const message = call[3];
                if (!looksLikeUserCopy(message)) continue;
                const afterMessage = (call.index ?? 0) + call[0].length;
                if (CARRIES_CODE.test(argsAfter(src, afterMessage))) continue; // coded — exempt
                hits.push({ file: path.relative(root, full), message });
            }
        }
    };
    for (const d of dirs) walk(path.join(root, d));
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
 */
const CURRENT_BASELINE = 530;

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
