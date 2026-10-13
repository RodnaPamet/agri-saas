/**
 * A docblock must not INSTRUCT the reader to call a deleted function (P1.10).
 *
 * ## The residue this closes
 *
 * P1.7 deleted `runInGlobalContext` in favour of the typed
 * `runWithoutRls({ reason })`, and recorded in its own completion note that
 * two docblocks still named it — *"stale prose, no live dependency"*. That
 * assessment was right about the dependency and wrong about the cost: the
 * prose outlived the symbol by three phases, and `src/app-layer/repositories/
 * exchange.ts` still carried **"MUST be called with an RLS-BYPASSING client
 * (`runInGlobalContext`)"** — an instruction nobody can follow.
 *
 * The danger is specific. A reader who tries it, finds nothing, and reaches
 * for the global client directly performs exactly the untyped bypass the typed
 * reason exists to prevent. And `src/app-layer/usecases/portfolio.ts` asserted
 * a SAFETY property — "we do NOT call `runInGlobalContext` for per-row
 * business data" — in terms of a function that cannot be called, so the claim
 * was unfalsifiable rather than true.
 *
 * ## It permits history, and that distinction is the whole design
 *
 * "This used to call X, which was deleted" is valuable and must stay sayable —
 * CLAUDE.md records several corrections in exactly that form, and deleting
 * them would lose why the current shape exists. What is banned is the
 * IMPERATIVE: `MUST be called with X`, `use X`, `call X`, `go through X`.
 *
 * So a mention is an offence only when it is not marked as history. A phrase
 * like "deleted", "previously", "was", or a phase reference makes it a record
 * rather than an instruction.
 *
 * ## Population
 *
 * Derived from the filesystem over `src/`, with the banned names listed
 * explicitly — one entry per symbol this repo has deleted and kept talking
 * about. A registry rather than a heuristic, because "is this identifier
 * deleted?" cannot be answered by scanning prose.
 */
import { readFileSync } from 'fs';
import { relative } from 'path';

import { collectSourceFiles } from '../helpers/collect-files';

const ROOT = process.cwd();

/**
 * Symbols this repo deleted, with what to use instead.
 *
 * An entry earns its place by having been deleted AND still mentioned. Adding
 * one is cheap; the guard then holds every future mention to the history form.
 */
const DELETED_SYMBOLS: Record<string, string> = {
    runInGlobalContext: "runWithoutRls({ reason }) — P1.7 replaced the untyped bypass with a typed one",
};

/** Words that make a mention a RECORD rather than an instruction. */
const HISTORY_MARKERS = /deleted|removed|previously|used to|no longer|since|formerly|was\b|P1\.\d|#\d{3,}/i;

/** Imperatives that make a mention an INSTRUCTION. */
const IMPERATIVES = /\b(MUST be called with|must use|should use|call|use|go through|pass|wrap (?:it |this )?in)\b/i;

interface Offence {
    file: string;
    line: number;
    symbol: string;
    text: string;
}

function scan(): { offences: Offence[]; mentions: number } {
    const files = collectSourceFiles({ roots: ['src'], floor: 500 });
    const offences: Offence[] = [];
    let mentions = 0;

    for (const abs of files) {
        const src = readFileSync(abs, 'utf8');
        const lines = src.split('\n');
        for (const [symbol] of Object.entries(DELETED_SYMBOLS)) {
            if (!src.includes(symbol)) continue;
            lines.forEach((line, i) => {
                if (!line.includes(symbol)) return;
                mentions += 1;
                // The sentence a reader sees: this line plus its neighbours,
                // because a docblock wraps and the history marker is often on
                // the line before or after the symbol.
                const window = lines.slice(Math.max(0, i - 2), i + 3).join(' ');
                if (HISTORY_MARKERS.test(window)) return;
                if (!IMPERATIVES.test(window)) return;
                offences.push({
                    file: relative(ROOT, abs),
                    line: i + 1,
                    symbol,
                    text: line.trim().slice(0, 100),
                });
            });
        }
    }
    return { offences, mentions };
}

describe('deleted symbols are recorded, never instructed', () => {
    it('finds the mentions at all — the positive control', () => {
        // Without this the suite passes when the scan selects nothing, which is
        // the empty-selection trap. The symbol IS still mentioned (as history),
        // so a zero here means the scanner broke, not that the repo is clean.
        const { mentions } = scan();
        expect({ mentions }).toEqual({ mentions });
        expect(mentions).toBeGreaterThan(0);
    });

    it('no docblock instructs a reader to call a deleted symbol', () => {
        const { offences } = scan();

        // The failure message carries the replacement, so the remedy is in the
        // error rather than in whoever remembers it.
        const detail = offences.map(
            (o) => `${o.file}:${o.line} — "${o.text}" → use ${DELETED_SYMBOLS[o.symbol]}`,
        );
        expect(detail).toEqual([]);
    });
});

describe('the detector can fail', () => {
    // Mutation proof in place: the matcher is two regexes over a text window,
    // and either could stop matching without anything going red.
    it('an imperative mention with no history marker IS an offence', () => {
        const line = ' * MUST be called with an RLS-BYPASSING client (`runInGlobalContext`):';
        expect(IMPERATIVES.test(line)).toBe(true);
        expect(HISTORY_MARKERS.test(line)).toBe(false);
    });

    it('the same mention marked as history is NOT', () => {
        const line = ' * This named `runInGlobalContext`, deleted by P1.7; use runWithoutRls.';
        expect(HISTORY_MARKERS.test(line)).toBe(true);
    });

    it('a bare mention with no imperative is NOT an offence', () => {
        // Naming a symbol in passing is not an instruction, and flagging it
        // would make the guard cry wolf on every retrospective comment.
        const line = ' * The old bypass was wider than this one.';
        expect(IMPERATIVES.test(line) && line.includes('runInGlobalContext')).toBe(false);
    });
});
