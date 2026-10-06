#!/usr/bin/env node
/**
 * design/tokens.json -> src/styles/tokens.generated.css + design/Tokens.swift
 *
 * P2.3. One source for both platforms, so a colour change is a one-file edit
 * and web/iOS cannot drift apart silently.
 *
 * ── what stays hand-authored, and why ──
 *
 * `src/styles/tokens.css` keeps the PROSE — 757 of its 1,170 lines were
 * comments carrying WCAG measurements, the GAP-CI-77 history, and the
 * reasoning behind each tier. That does not belong in JSON: paragraphs read
 * badly there and the next author would skip writing them. Short per-token
 * notes DO travel in the JSON, because they describe the value and belong
 * beside it.
 *
 * ── theme inheritance is load-bearing ──
 *
 * A theme declares only what it OVERRIDES: light carries 118 of dark's 130,
 * highContrast only 20. The CSS cascade handles that for the web. Swift has no
 * cascade, so each theme is emitted FULLY RESOLVED against dark — otherwise an
 * iOS high-contrast build would be missing 110 colours.
 *
 * Usage:
 *   node scripts/generate-tokens.mjs           # write both files
 *   node scripts/generate-tokens.mjs --check    # exit 1 if either is stale
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'design/tokens.json');
const CSS_FILE = path.join(ROOT, 'src/styles/tokens.css');
const SWIFT_OUT = path.join(ROOT, 'design/Tokens.swift');
const CHECK = process.argv.includes('--check');

const spec = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const THEME_ORDER = ['dark', 'light', 'highContrast'];

for (const t of THEME_ORDER) {
    if (!spec.themes[t]) throw new Error(`design/tokens.json is missing theme "${t}"`);
    if (!spec.themeSelectors[t]) throw new Error(`no selector declared for theme "${t}"`);
}

// ─── CSS ────────────────────────────────────────────────────────────────────

/**
 * One space after the colon. Not an aesthetic choice — a contract.
 *
 * The first version padded declarations into columns, which reads nicely and
 * broke five guard assertions that use an exact substring:
 * `toContain('--chart-hover-pop-distance: 4px;')`. Measured across the repo:
 * 5 assertions require the single-space form and NONE expects padding, so
 * padding can only ever lose. (The pre-migration file was itself inconsistent
 * — 134 single-spaced and 137 padded — which is how the two conventions
 * coexisted without anyone noticing.)
 */
function cssFor(theme) {
    const toks = spec.themes[theme];
    const body = Object.keys(toks)
        .map((n) => {
            const { value, note } = toks[n];
            const decl = `  --${n}: ${value};`;
            return note ? `${decl}  /* ${note} */` : decl;
        })
        .join('\n');
    return `${spec.themeSelectors[theme]} {\n${body}\n}`;
}

/**
 * Rewrite the VALUE on each declaration line, and nothing else.
 *
 * Two earlier designs both broke a structural contract this repo holds and I
 * did not know about:
 *
 *   1. A separate `tokens.generated.css` that tokens.css imported. THIRTY guard
 *      files read `src/styles/tokens.css` directly to assert "this token is
 *      declared in the canonical token file" (R13/R16/R18/R19/R20/R22/R24/R27,
 *      B10 …). Moving the declarations out broke all of it; three CI shards
 *      said so.
 *
 *   2. Generating whole theme blocks between markers, with the prose lifted
 *      out to a notes section. `r13-secondary-brand-tokens` asserts that a
 *      "complementary / counterpoint / cool" rationale sits BETWEEN
 *      `--brand-default:` and `--brand-secondary-default:` inside the block —
 *      "the rationale lives next to the value". Five paragraphs explaining why
 *      white replaced electric blue lived exactly there, and lifting them out
 *      destroyed that adjacency. Weakening the guard to look file-wide would
 *      have defeated its whole point.
 *
 * So this touches only what it owns: for every line that declares a token, the
 * value (and its trailing note) comes from the JSON. Prose, blank lines,
 * section headers, ordering and indentation are left byte-for-byte alone. One
 * edit to design/tokens.json still updates the web CSS and Tokens.swift
 * together, and nothing about the file's shape is the generator's business.
 */
const DECL_LINE = /^(\s*)(--[a-z][a-z0-9-]*)(\s*):(\s*)([^;]*);(.*)$/;

/**
 * Which theme block a line sits in, or null if it is not in one.
 *
 * `null` covers the reduced-motion overrides: `@media
 * (prefers-reduced-motion: reduce) { :root { --duration-*: 1ms } }` is a media
 * query, not a theme, and is hand-authored. Walking back to the nearest
 * column-0 selector attributed those three to `[data-contrast="high"]` —
 * whichever theme happened to be declared last — so media depth is tracked
 * rather than inferred from proximity.
 */
function themeOfLine(lines, i) {
    let theme = null;
    let mediaDepth = 0;
    let inMedia = false;
    for (let j = 0; j <= i; j++) {
        const line = lines[j];
        if (/^@media\b/.test(line)) { inMedia = true; mediaDepth = 0; }
        if (inMedia) {
            mediaDepth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
            if (mediaDepth <= 0 && !/^@media\b/.test(line)) inMedia = false;
            continue;
        }
        for (const [key, sel] of Object.entries(spec.themeSelectors)) {
            if (line.startsWith(sel) && line.includes('{')) theme = key;
        }
    }
    return inMedia ? null : theme;
}

function rewriteCss() {
    const lines = fs.readFileSync(CSS_FILE, 'utf8').split('\n');
    let rewritten = 0;
    const unknown = [];
    const seen = new Map();

    for (let i = 0; i < lines.length; i++) {
        const m = DECL_LINE.exec(lines[i]);
        if (!m) continue;
        const [, indent, name, preColon, postColon, , tail] = m;
        const theme = themeOfLine(lines, i);
        // The reduced-motion block is a media query, not a theme: it overrides
        // --duration-* deliberately and is hand-authored.
        if (!theme) continue;
        const tok = spec.themes[theme]?.[name.slice(2)];
        if (!tok) { unknown.push(`${name} in ${theme} (line ${i + 1})`); continue; }
        const note = tok.note ? `  /* ${tok.note} */` : '';
        // Preserve the author's own spacing around the colon; replace the value
        // and the trailing comment only.
        lines[i] = `${indent}${name}${preColon}:${postColon}${tok.value};${note}`;
        rewritten++;
        (seen.get(theme) ?? seen.set(theme, new Set()).get(theme)).add(name.slice(2));
    }

    if (unknown.length) {
        throw new Error(
            `tokens.css declares ${unknown.length} token(s) absent from design/tokens.json:\n  ` +
                unknown.join('\n  ') +
                `\nAdd them to the JSON (it is the source) or remove them from the CSS.`,
        );
    }

    // A token added to the JSON must reach the CSS, or the JSON silently stops
    // being the source for it.
    const missing = [];
    for (const theme of THEME_ORDER) {
        for (const name of Object.keys(spec.themes[theme])) {
            if (!seen.get(theme)?.has(name)) missing.push(`--${name} (${theme})`);
        }
    }
    if (missing.length) {
        throw new Error(
            `design/tokens.json declares ${missing.length} token(s) that tokens.css does not:\n  ` +
                missing.join('\n  ') +
                `\nAdd the declaration line to the right theme block in src/styles/tokens.css.`,
        );
    }

    return { css: lines.join('\n'), rewritten };
}

const { css, rewritten: declsRewritten } = rewriteCss();

// ─── Swift ──────────────────────────────────────────────────────────────────

/** Resolve `var(--x)` chains within a theme, falling back to dark. */
function resolve(theme, name, seen = new Set()) {
    if (seen.has(name)) throw new Error(`token cycle at --${name} in ${theme}`);
    seen.add(name);
    const tok = spec.themes[theme][name] ?? spec.themes.dark[name];
    if (!tok) return null;
    const m = /^var\(--([a-z0-9-]+)\)$/.exec(tok.value.trim());
    return m ? resolve(theme, m[1], seen) : tok.value.trim();
}

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGBA = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/;
const DURATION = /^([\d.]+)(ms|s)$/;
const LENGTH = /^([\d.]+)px$/;

function swiftColour(value) {
    const hex = HEX.exec(value);
    if (hex) {
        let h = hex[1];
        if (h.length === 3) h = h.split('').map((c) => c + c).join('');
        const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
        return { r, g, b, a };
    }
    const rgba = RGBA.exec(value);
    if (rgba) {
        return {
            r: Number(rgba[1]) / 255,
            g: Number(rgba[2]) / 255,
            b: Number(rgba[3]) / 255,
            a: rgba[4] === undefined ? 1 : Number(rgba[4]),
        };
    }
    return null;
}

const f = (n) => n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');
const camel = (n) => n.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

function swift() {
    const allNames = Object.keys(spec.themes.dark);
    const colours = [];
    const durations = [];
    const lengths = [];
    const skipped = [];

    for (const name of allNames) {
        const perTheme = {};
        let kind = null;
        for (const theme of THEME_ORDER) {
            const v = resolve(theme, name);
            if (v == null) continue;
            const c = swiftColour(v);
            if (c) { perTheme[theme] = c; kind = kind ?? 'colour'; continue; }
            const d = DURATION.exec(v);
            if (d) { perTheme[theme] = Number(d[1]) * (d[2] === 's' ? 1000 : 1); kind = kind ?? 'duration'; continue; }
            const l = LENGTH.exec(v);
            if (l) { perTheme[theme] = Number(l[1]); kind = kind ?? 'length'; continue; }
            kind = 'unsupported';
        }
        if (kind === 'colour') colours.push([name, perTheme]);
        else if (kind === 'duration') durations.push([name, perTheme]);
        else if (kind === 'length') lengths.push([name, perTheme]);
        else skipped.push(name);
    }

    const colourCase = (name, perTheme) => {
        const arms = THEME_ORDER.map((t) => {
            const c = perTheme[t] ?? perTheme.dark;
            return `        case .${t}: return Color(red: ${f(c.r)}, green: ${f(c.g)}, blue: ${f(c.b)}, opacity: ${f(c.a)})`;
        }).join('\n');
        const note = spec.themes.dark[name]?.note;
        return `    /// ${note ? note.replace(/\s+/g, ' ') : `--${name}`}\n    static func ${camel(name)}(_ theme: AgrentTheme) -> Color {\n        switch theme {\n${arms}\n        }\n    }`;
    };

    const scalarCase = (name, perTheme, type) => {
        const arms = THEME_ORDER.map((t) => `        case .${t}: return ${f(perTheme[t] ?? perTheme.dark)}`).join('\n');
        return `    static func ${camel(name)}(_ theme: AgrentTheme) -> ${type} {\n        switch theme {\n${arms}\n        }\n    }`;
    };

    return [
        '// GENERATED by scripts/generate-tokens.mjs from design/tokens.json.',
        '// Do not edit: `npm run tokens:check` fails on any hand edit.',
        '//',
        '// Every theme is FULLY RESOLVED against dark, because Swift has no CSS',
        `// cascade: light overrides ${Object.keys(spec.themes.light).length} of dark's ${Object.keys(spec.themes.dark).length} tokens and highContrast only ${Object.keys(spec.themes.highContrast).length},`,
        '// so emitting each theme\'s own block alone would leave an iOS build',
        '// missing most of its palette.',
        '//',
        `// ${skipped.length} tokens are NOT emitted: gradients and multi-value shadows have`,
        '// no single Swift value, and iOS composes those natively. They are listed',
        '// at the bottom of this file so the omission is visible rather than silent.',
        '',
        'import SwiftUI',
        '',
        'public enum AgrentTheme: String, CaseIterable, Sendable {',
        ...THEME_ORDER.map((t) => `    case ${t}`),
        '}',
        '',
        'public enum AgrentColor {',
        colours.map(([n, p]) => colourCase(n, p)).join('\n\n'),
        '}',
        '',
        'public enum AgrentDuration {',
        '    /// Milliseconds.',
        durations.map(([n, p]) => scalarCase(n, p, 'Double')).join('\n\n'),
        '}',
        '',
        'public enum AgrentMetric {',
        '    /// Points, taken from the web token\'s px value.',
        lengths.map(([n, p]) => scalarCase(n, p, 'CGFloat')).join('\n\n'),
        '}',
        '',
        '// Not emitted (gradients / multi-value shadows / non-scalar):',
        ...skipped.map((n) => `//   --${n}`),
        '',
    ].join('\n');
}

const swiftSrc = swift();

if (CHECK) {
    let stale = [];
    for (const [file, want] of [[CSS_FILE, css], [SWIFT_OUT, swiftSrc]]) {
        const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        if (have !== want) stale.push(path.relative(ROOT, file));
    }
    if (stale.length) {
        console.error(`STALE: ${stale.join(', ')}`);
        console.error('design/tokens.json changed without regenerating. Run: npm run tokens:generate');
        process.exit(1);
    }
    console.log('tokens: generated files are in sync with design/tokens.json');
    process.exit(0);
}

fs.writeFileSync(CSS_FILE, css);
fs.writeFileSync(SWIFT_OUT, swiftSrc);
console.log(`wrote ${path.relative(ROOT, CSS_FILE)} (${declsRewritten} declaration values rewritten in place; prose untouched)`);
console.log(`wrote ${path.relative(ROOT, SWIFT_OUT)} (${swiftSrc.split('\n').length} lines)`);
