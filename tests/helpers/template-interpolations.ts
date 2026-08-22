/**
 * Brace-balanced extraction of `${…}` interpolations from template literals.
 *
 * ## Why this is not a regex (#717)
 *
 * `html-template-escaping.test.ts` used `/\$\{([^}{]*)\}/g`. The negated class
 * excludes `{`, so an interpolation whose expression contains a brace never
 * matched — it was not reported as unescaped, it was **not seen**. The guard
 * failed OPEN.
 *
 * Proven against the real guard before this fix, with two probe files dropped
 * into a scanned directory:
 *
 * ```ts
 * return `<p>${evil}</p>`;                                // exit 1  ← caught
 * return `<p>${await t('greeting', { name: evil })}</p>`; // exit 0  ← blind
 * ```
 *
 * Probe B interpolates attacker-controlled data into HTML with no escaping at
 * all and the guard was silent. The only difference is the `{ name: … }` — and
 * that is the ordinary shape of an i18n call with parameters, which is what
 * localising the notification templates (#694) introduces at scale into the
 * guarded directory.
 *
 * ## What "structural" means here
 *
 * An interpolation whose expression itself contains a nested template literal
 * is a COMPOSITION, not a value:
 *
 * ```ts
 * `<div>${cond ? `<b>${escapeHtml(x)}</b>` : ''}</div>`
 * ```
 *
 * Demanding `escapeHtml()` around that wrapper would be actively wrong — it
 * would escape the markup the wrapper exists to emit. The nested literal is
 * returned as a template in its own right, so its interpolations are checked
 * individually. The old regex arrived at the same outcome by accident (its
 * literal matcher stopped at the inner backtick); here it is deliberate, and
 * the wrapper is marked `structural` so a caller can decide rather than guess.
 *
 * @module tests/helpers/template-interpolations
 */

export interface Interpolation {
    /** The trimmed expression source between `${` and its balancing `}`. */
    expr: string;
    /**
     * True when the expression contains a nested template literal, i.e. it
     * composes markup rather than injecting a value. Its nested literals are
     * returned separately and checked on their own.
     */
    structural: boolean;
}

export interface TemplateLiteral {
    /** The literal's raw source, backticks included. */
    raw: string;
    interpolations: Interpolation[];
}

/** Skip a `'…'` or `"…"` string; returns the index just past the closer. */
function skipQuoted(src: string, start: number): number {
    const quote = src[start];
    let i = start + 1;
    while (i < src.length) {
        if (src[i] === '\\') {
            i += 2;
            continue;
        }
        if (src[i] === quote) return i + 1;
        if (src[i] === '\n') return i; // unterminated — do not run away
        i += 1;
    }
    return i;
}

/** Skip a line or block comment; returns the index just past it. */
function skipComment(src: string, start: number): number {
    if (src[start + 1] === '/') {
        const nl = src.indexOf('\n', start);
        return nl < 0 ? src.length : nl;
    }
    const end = src.indexOf('*/', start + 2);
    return end < 0 ? src.length : end + 2;
}

/**
 * From the index just past `${`, walk to the balancing `}`.
 *
 * Tracks brace depth while skipping over strings, comments and nested template
 * literals, so a `}` inside any of those does not close the interpolation.
 */
function readBalanced(src: string, start: number): { expr: string; end: number } {
    let depth = 1;
    let i = start;
    while (i < src.length) {
        const c = src[i];
        if (c === '\\') {
            i += 2;
            continue;
        }
        if (c === '"' || c === "'") {
            i = skipQuoted(src, i);
            continue;
        }
        if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
            i = skipComment(src, i);
            continue;
        }
        if (c === '`') {
            i = readTemplate(src, i).end;
            continue;
        }
        if (c === '{') depth += 1;
        else if (c === '}') {
            depth -= 1;
            if (depth === 0) return { expr: src.slice(start, i), end: i + 1 };
        }
        i += 1;
    }
    return { expr: src.slice(start), end: src.length };
}

/**
 * Parse the template literal beginning at `start` (which must be a backtick).
 *
 * Returns the literal itself plus every template literal nested inside its
 * interpolations, so a caller sees all of them.
 */
function readTemplate(
    src: string,
    start: number,
): { templates: TemplateLiteral[]; end: number } {
    const interpolations: Interpolation[] = [];
    const nested: TemplateLiteral[] = [];
    let i = start + 1;

    while (i < src.length) {
        const c = src[i];
        if (c === '\\') {
            i += 2;
            continue;
        }
        if (c === '`') {
            i += 1;
            break;
        }
        if (c === '$' && src[i + 1] === '{') {
            const { expr, end } = readBalanced(src, i + 2);
            const inner = collectTemplates(expr);
            interpolations.push({ expr: expr.trim(), structural: inner.length > 0 });
            nested.push(...inner);
            i = end;
            continue;
        }
        i += 1;
    }

    const raw = src.slice(start, i);
    return { templates: [{ raw, interpolations }, ...nested], end: i };
}

/** Every template literal in `src`, including nested ones, in source order. */
export function collectTemplates(src: string): TemplateLiteral[] {
    const out: TemplateLiteral[] = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '\\') {
            i += 2;
            continue;
        }
        if (c === '"' || c === "'") {
            i = skipQuoted(src, i);
            continue;
        }
        if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
            i = skipComment(src, i);
            continue;
        }
        if (c === '`') {
            const { templates, end } = readTemplate(src, i);
            out.push(...templates);
            i = end;
            continue;
        }
        i += 1;
    }
    return out;
}
