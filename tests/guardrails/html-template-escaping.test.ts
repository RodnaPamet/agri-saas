/**
 * Guardrail — every value interpolated into an HTML email/notification
 * template goes through `escapeHtml`.
 *
 * ## The bug class this exists to stop
 *
 * `sanitizePlainText` strips tags and then DELIBERATELY decodes the canonical
 * entities, so the stored value is the literal text a user typed. That is
 * correct for a plain-text consumer and `tests/unit/security/sanitize.test.ts`
 * pins it.
 *
 * An HTML template is not a plain-text consumer. A sanitised value carrying
 * `&lt;a href="…"&gt;` is stored as `<a href="…">` and rendered by the mail
 * client as a working anchor. The Exchange inquiry email was exactly this: a
 * message field sanitised at the usecase and interpolated raw into HTML, which
 * let an EDITOR in any tenant deliver a phishing anchor — from the platform's
 * own signed domain — into another tenant's owner/admin inbox. No script tag
 * required; an anchor and a remote image are enough for credential theft and
 * read-receipt disclosure.
 *
 * Sanitising at the source and escaping at the sink are different jobs. This
 * guardrail enforces the second one, because it is a class of bug: the fix to
 * one template does nothing for the next template someone adds.
 *
 * ## How it works
 *
 * Scans the HTML-emitting modules for template literals that contain markup
 * (`<` followed by a letter), extracts every `${…}` interpolation, and
 * requires each to either call `escapeHtml(` or match an entry in
 * `SAFE_BY_CONSTRUCTION` below.
 *
 * **Adding an entry to that list is a security decision.** It needs a written
 * reason, and the reason must be that the value CANNOT be a user-supplied
 * string — not that it is unlikely to be one today.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectTemplates } from '../helpers/template-interpolations';

const ROOT = path.resolve(__dirname, '../..');

/** Directories whose HTML output is delivered to a human's inbox. */
const SCANNED_DIRS = ['src/lib/email', 'src/app-layer/notifications'];

/**
 * Interpolations that cannot carry user-supplied text.
 *
 * Each entry is the exact trimmed expression source. Two admissible reasons:
 * the value is NUMERIC (no markup is expressible), or it is an already-escaped
 * HTML FRAGMENT composed by another function in this same guarded set.
 */
const SAFE_BY_CONSTRUCTION: Record<string, string> = {
    // ── Numeric: cannot express markup ──
    days: 'number — day count computed from a Date difference',
    'days === 1 ? \'\' : \'s\'': 'ternary over two string literals — no external input',
    // Surfaced by the #717 parser fix, not by new code: it sits inside a
    // NESTED template literal, and the old regex's outer-literal matcher
    // stopped at the inner backtick, so this region was never parsed properly.
    // A hex colour chosen from two string constants — no external input, and a
    // `#rrggbb` value cannot express markup.
    "isApproved ? '#10b981' : '#ef4444'":
        'ternary over two hex-colour literals — no external input, no markup expressible',
    'items.length': 'number — array length',
    daysRemaining: 'number — computed day count',
    submittedScore: 'number — declared `submittedScore: number` on the template params',
    finalScore: 'number — declared `finalScore: number` on the template params',
    pendingDecisions: 'number — declared `pendingDecisions: number` on the template params',
    totalDecisions: 'number — declared `totalDecisions: number` on the template params',
    daysOverdue: 'number — declared `daysOverdue: number` on the template params',
    // ── Already-escaped HTML fragments composed inside this guarded set ──
    rows: 'HTML fragment built by buildDigestTable, whose own cells are escaped',
    'buildDigestTable(items, tenantSlug)':
        'HTML fragment; the function is in this guarded set and escapes its own cells',
};

function walk(dir: string, acc: string[] = []): string[] {
    if (!fs.existsSync(dir)) return acc;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, acc);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) acc.push(full);
    }
    return acc;
}

interface Finding {
    file: string;
    expr: string;
}

/**
 * Every `${…}` inside a template literal that contains HTML markup.
 *
 * Extraction is BRACE-BALANCED, not regex (#717). The previous version used
 * `/\$\{([^}{]*)\}/g`, whose negated class excludes `{` — so an interpolation
 * whose expression contained a brace was never SEEN, escaped or not, and the
 * guard failed OPEN on it. That is the ordinary shape of an i18n call with
 * parameters (`t('k', { name })`), which is what localising these templates
 * introduces at scale.
 */
function findUnescapedInterpolations(files: string[]): Finding[] {
    const out: Finding[] = [];
    for (const file of files) {
        out.push(
            ...scanSource(fs.readFileSync(file, 'utf8')).map((expr) => ({
                file: path.relative(ROOT, file),
                expr,
            })),
        );
    }
    return out;
}

/** The file-independent half, so the detector can be driven from a string. */
function scanSource(src: string): string[] {
    const out: string[] = [];
    for (const tpl of collectTemplates(src)) {
        if (!/<[a-zA-Z]/.test(tpl.raw)) continue; // not an HTML template
        for (const { expr, structural } of tpl.interpolations) {
            if (!expr) continue;
            // A wrapper that composes markup from a NESTED literal is not a
            // value being injected; escaping it would destroy the markup it
            // exists to emit. The nested literal is returned separately and
            // its own interpolations are checked on the next iteration.
            if (structural) continue;
            if (expr.includes('escapeHtml(')) continue;
            if (expr in SAFE_BY_CONSTRUCTION) continue;
            out.push(expr);
        }
    }
    return out;
}

const FILES = SCANNED_DIRS.flatMap((d) => walk(path.join(ROOT, d)));

describe('Guardrail: HTML templates escape every interpolated value', () => {
    it('finds the modules it is supposed to be guarding', () => {
        // A refactor that moves these files must move the guardrail with them,
        // rather than leaving it silently scanning nothing.
        expect(FILES.length).toBeGreaterThan(0);
        expect(FILES.some((f) => f.endsWith('inquiry-email.ts'))).toBe(true);
        expect(FILES.some((f) => f.endsWith('templates.ts'))).toBe(true);
    });

    it('has no unescaped interpolation in any HTML template', () => {
        const findings = findUnescapedInterpolations(FILES);
        const report = findings
            .map((f) => `  ${f.file}\n      \${${f.expr}}`)
            .join('\n');
        expect(
            findings.length === 0
                ? ''
                : `Unescaped value(s) reaching an HTML template:\n${report}\n\n` +
                  'Wrap each in escapeHtml() from @/lib/security/escape-html.\n' +
                  'Do NOT fix this by changing sanitizePlainText — it decodes entities ' +
                  'by design and other callers depend on that.\n' +
                  'If a value genuinely cannot be user-supplied, add it to ' +
                  'SAFE_BY_CONSTRUCTION with a written reason.',
        ).toBe('');
    });

    /**
     * The detector's own resolving power (#717).
     *
     * This guard failed OPEN for its entire life on one expression shape, and
     * nothing here could have told you: every assertion above is of the form
     * "no findings", which a detector that finds nothing satisfies perfectly.
     * These drive `scanSource` against fixtures instead — the shape
     * `payload-url-scheme.test.ts` uses.
     */
    describe('the detector actually detects', () => {
        it('catches a plainly unescaped interpolation', () => {
            expect(scanSource('const h = `<p>${evil}</p>`;')).toEqual(['evil']);
        });

        it('CATCHES an unescaped interpolation containing an object literal', () => {
            // THE #717 REGRESSION. Verified against the pre-fix guard by
            // dropping this exact shape into a scanned directory: it exited 0,
            // reporting nothing, while interpolating attacker data into HTML
            // with no escaping at all. The old regex could not see past the `{`.
            expect(
                scanSource("const h = `<p>${await t('greeting', { name: evil })}</p>`;"),
            ).toEqual(["await t('greeting', { name: evil })"]);
        });

        it('accepts the same expression once escaped', () => {
            expect(
                scanSource(
                    "const h = `<p>${escapeHtml(await t('greeting', { name: evil }))}</p>`;",
                ),
            ).toEqual([]);
        });

        it('does not demand escaping of a wrapper that composes a NESTED literal', () => {
            // Escaping this would destroy the markup it exists to emit. The
            // nested literal is checked in its own right — see the next case.
            expect(
                scanSource("const h = `<div>${cond ? `<b>${escapeHtml(x)}</b>` : ''}</div>`;"),
            ).toEqual([]);
        });

        it('…and still catches an unescaped value INSIDE that nested literal', () => {
            expect(
                scanSource("const h = `<div>${cond ? `<b>${x}</b>` : ''}</div>`;"),
            ).toEqual(['x']);
        });

        it('ignores a template literal with no markup', () => {
            expect(scanSource('const s = `hello ${name}`;')).toEqual([]);
        });

        it('is not confused by a brace inside a string, or by a comment', () => {
            expect(scanSource('const h = `<p>${fmt("}")}</p>`;')).toEqual(['fmt("}")']);
            expect(scanSource('// `<p>${evil}</p>`\nconst x = 1;')).toEqual([]);
        });
    });

    it('keeps escapeHtml on a single definition', () => {
        // Three copies existed before this guardrail; two drifting copies is
        // how one of them ends up missing a character class.
        const copies = FILES.filter((f) =>
            /function escapeHtml\s*\(/.test(fs.readFileSync(f, 'utf8')),
        );
        expect(copies).toEqual([]);
    });

    it('escapes the characters that break out of content and quoted attributes', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { escapeHtml } = require('@/lib/security/escape-html');
        expect(escapeHtml('<a href="x">')).toBe('&lt;a href=&quot;x&quot;&gt;');
        expect(escapeHtml("it's & more")).toBe('it&#39;s &amp; more');
        // `&` first, so an entity introduced by a later rule is not re-escaped.
        expect(escapeHtml('&lt;')).toBe('&amp;lt;');
    });

    it('detects a regression when an escape is removed', () => {
        // Mutation proof: the scan must actually fail on a bad template,
        // otherwise a green run proves nothing.
        const tmp = path.join(ROOT, 'node_modules/.cache/html-escape-probe.ts');
        fs.mkdirSync(path.dirname(tmp), { recursive: true });
        fs.writeFileSync(tmp, 'const x = `<p>${userMessage}</p>`;\n');
        try {
            const findings = findUnescapedInterpolations([tmp]);
            expect(findings.map((f) => f.expr)).toEqual(['userMessage']);
        } finally {
            fs.unlinkSync(tmp);
        }
    });
});
