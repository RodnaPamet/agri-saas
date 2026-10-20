/**
 * Guard: a new refusal code ships with its Bulgarian entry (#1677, #1918).
 *
 * ## The decision #1677 left open has in fact been taken
 *
 * #1677 names three ways out and says none was chosen. Option 3 — "resolve
 * `message` server-side from the request locale" — is what shipped:
 * `localizeErrorPayload` looks up `errors.<CODE>` and REPLACES
 * `error.message`, so an entried code reads in the caller's language on both
 * clients and needs nothing from either.
 *
 * That settles the convention question #1677 asks. `coded*()`'s English
 * second argument is not displayed copy for an entried code — it is the
 * FALLBACK for an unentried one, and the English prose is right for that job.
 *
 * What #1677 is left asking is the thing nothing enforced: the entry has to
 * exist. A code without one falls through to English, and
 * `src/lib/api-client.ts` prints `error.message` at 142 web call sites with
 * no language test, so the fallback is what a Bulgarian farmer reads.
 *
 * ## Why a ratchet and not a rule
 *
 * 81 codes have no entry today. A guard demanding all 81 at once would be
 * reverted, so they are grandfathered BY NAME below and the list may only
 * shrink. What the guard actually stops is the 82nd — which is the thing that
 * made this a backlog of 124 rather than a handful.
 *
 * The two lists are separate on purpose. `BACKLOG` is "not yet";
 * `DELIBERATELY_UNENTRIED` is "never", each with the reason attached. A
 * single list would let a decision rot into a to-do item, and that
 * distinction is the one this repo keeps having to rediscover.
 *
 * ## The lists must be EXACT, and that churn is the point
 *
 * Their union must equal the live unentried set — not contain it. A stale
 * name is how a cap accumulates slack until it stops meaning anything, so a
 * batch that adds entries MUST delete those names here, and the diff is then
 * the record of progress. An entry for a code nothing throws fails too:
 * `THREAD_CLOSED` was nominated for translation from a spec sentence that
 * documents its REMOVAL.
 */
import { cataloguePath, readCatalogue } from '../helpers/catalogue';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { relative } from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/**
 * Codes that must NEVER get an entry, with the reason.
 *
 * An entry REPLACES `message` for every site of that code, in every locale,
 * so a code whose wording is composed per-site cannot have one.
 */
const DELIBERATELY_UNENTRIED: ReadonlyArray<[code: string, why: string]> = [
    [
        'FILE_TYPE_NOT_ALLOWED',
        'Five sites, and one passes a CALLER-SUPPLIED reason (`extraRejection` from ' +
            '`opts.extraCheck`) — an entry would replace "avatars must be square" with a generic sentence.',
    ],
    [
        'FILE_VALIDATION_ERROR',
        'Its message IS the validator\'s own — `err instanceof Error ? err.message : ...` — so an ' +
            'entry would replace a specific explanation ("file exceeds 10 MB") with a generic one. ' +
            'Same shape as FILE_TYPE_NOT_ALLOWED above, and the same fix if it is ever wanted: give ' +
            'the validator coded sub-errors, which is a change to the upload path rather than a ' +
            'catalogue batch. Moved here from BACKLOG in batch 11 — it was never "not yet".',
    ],
    [
        'BLOCK_SELLER_ONLY',
        'P5.7 vocabulary in another session\'s lane, so not mine to word. Asserted as absent in ' +
            '`refusal-codes-read-in-bulgarian`, which is the case that caught batch 13 adding it.',
    ],
    [
        'THREAD_BLOCKED',
        'Same lane as BLOCK_SELLER_ONLY, AND its sentence already exists in this catalogue as ' +
            '`exchange.messaging.blockedForYou` («Този продавач не приема съобщения от Вас.»). An ' +
            'entry here would be a SECOND Bulgarian wording for one refusal — the #1966 defect. ' +
            'Batch 13 wrote one that differed only in «вас» vs «Вас», which is the subtlest possible ' +
            'version of that mistake.',
    ],
];

/**
 * Codes with no entry yet.
 *
 * **EMPTY as of batch 13, and it stays empty.** Every code thrown in `src/`
 * now has a Bulgarian entry except the three in `DELIBERATELY_UNENTRIED`,
 * each of which carries the reason an entry would make things worse.
 *
 * This held 124 names when #1918 opened and is now an assertion rather than a
 * list. The difference matters: while it had names, a new code shipped without
 * an entry could be "fixed" by adding a line here, and that is no longer
 * available. A new code either ships with its entry, or earns a documented
 * place in `DELIBERATELY_UNENTRIED` — which takes a reason, not a name, and
 * has its own minimum-length assertion.
 *
 * Emptiness is checked separately below, because the `no NEW code lacks an
 * entry` test is satisfied by a code AND its backlog line arriving together.
 */
const BACKLOG: ReadonlyArray<string> = [
];

/**
 * Every `coded*('CODE'` in `src/`, comments blanked, spec prose excluded.
 *
 * Through `collectSourceFiles` rather than a hand-rolled walk, because
 * `file-collection-is-not-silently-empty` is right about the failure it
 * prevents: a hand-rolled collector can be gutted to return `[]` with every
 * assertion built on it still green — measured at 81% of the guards an
 * automated sweep could audit. The `floor` is what makes "found nothing"
 * different from "nothing is wrong", and this guard's whole value is its
 * denominator.
 */
/**
 * Call sites where the CODE is not a literal, each declaring what it can throw
 * (#2008).
 *
 * This list is the fix for the hole that made this guard lie. It read only a
 * literal FIRST argument:
 *
 *     /coded[A-Za-z]*\s*\(\s*'([A-Z][A-Z0-9_]{3,})'/
 *
 * Measured across `src/`: 395 calls match that, and a handful do not. The ones
 * that did not were invisible, so **ten codes were thrown with neither an entry
 * nor a BACKLOG line and this guard said nothing**. Four of them —
 * `FARM_HANDLE_*` — have Bulgarian on the PHONE and not on the web, so the same
 * refusal for the same action read Bulgarian or English depending on the client.
 *
 * Two of the forms are now read automatically rather than declared: a ternary
 * between two literals, and `codedClientError(status, code, …)` where the code
 * is the SECOND argument. What remains here is what no parser should chase — a
 * variable or a function call.
 *
 * The list is asserted EXACT. A new opaque call site fails until someone names
 * its codes, which is the property the old regex lacked: it could not tell
 * "no dynamic sites" from "dynamic sites I cannot see".
 */
const DYNAMIC_CODE_SITES: ReadonlyArray<
    readonly [file: string, expr: string, codes: readonly string[]]
> = [
    [
        'src/app-layer/usecases/task.ts',
        'transitionErrorCode(transitionErr)',
        ['ILLEGAL_TRANSITION', 'TASK_STATUS_UNCHANGED', 'UNKNOWN_TASK_STATUS'],
    ],
    [
        'src/app-layer/usecases/contract.ts',
        'contractTransitionErrorCode(transitionErr)',
        [
            'CONTRACT_ILLEGAL_STATUS_TRANSITION',
            'CONTRACT_STORED_STATUS_UNKNOWN',
            'CONTRACT_TARGET_STATUS_UNKNOWN',
        ],
    ],
    [
        'src/app-layer/usecases/public-farm-profile.ts',
        'verdict.code',
        // Exactly the keys of HANDLE_REFUSAL_MESSAGES, which is what
        // `checkHandleShape` can refuse with.
        [
            'FARM_HANDLE_RESERVED',
            'FARM_HANDLE_TOO_LONG',
            'FARM_HANDLE_TOO_SHORT',
            'FARM_HANDLE_UNUSABLE',
        ],
    ],
    [
        // A PASS-THROUGH: it re-throws another error's own code, so it
        // introduces none of its own. Declared with an empty list rather than
        // omitted, because omitting it would be indistinguishable from not
        // having noticed it.
        'src/app/api/t/[tenantSlug]/locations/[id]/spatial-import/route.ts',
        'err.statusCode',
        [],
    ],
];

/** The balanced `(...)` following `start`, without the outer parentheses. */
function callArgs(code: string, start: number): string {
    const open = code.indexOf('(', start);
    if (open === -1) return '';
    let depth = 0;
    for (let i = open; i < code.length; i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')') {
            depth--;
            if (depth === 0) return code.slice(open + 1, i);
        }
    }
    return code.slice(open + 1);
}

/** The first `n` top-level, comma-separated arguments. */
function topLevelArgs(args: string, n: number): string[] {
    const out: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let cur = '';
    for (const ch of args) {
        if (quote) {
            cur += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            quote = ch;
            cur += ch;
            continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        else if (ch === ',' && depth === 0) {
            out.push(cur.trim());
            cur = '';
            if (out.length === n) return out;
            continue;
        }
        cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

interface ThrownScan {
    codes: Map<string, Set<string>>;
    /** Opaque sites as `file\u0000expr`, for the EXACT comparison below. */
    opaque: string[];
    literalCalls: number;
}

function thrownCodes(): ThrownScan {
    const found = new Map<string, Set<string>>();
    const opaque: string[] = [];
    let literalCalls = 0;
    const files = collectSourceFiles({ roots: ['src'], extensions: ['.ts', '.tsx'], floor: 500 });
    for (const full of files) {
        // `src/lib/openapi/` DOCUMENTS codes in prose, including retired
        // ones. A code mentioned there is not a code anything throws.
        if (full.includes(join('src', 'lib', 'openapi'))) continue;
        const code = blankNonCode(readFileSync(full, 'utf8'));
        const rel = full.slice(REPO_ROOT.length + 1);
        for (const m of code.matchAll(/\bcoded[A-Za-z]*\s*\(/g)) {
            const args = topLevelArgs(callArgs(code, m.index), 2);
            // `codedClientError(status, code, message)` puts the code SECOND.
            // Read the second argument ONLY in that case: scanning it
            // unconditionally would read an ALLCAPS token in a MESSAGE as a
            // code, which is the very defect #1965 removed from
            // `Task is ${task.status}`.
            const isStatusFirst = /^\d{3}$/.test(args[0] ?? '');
            const codeExpr = (isStatusFirst ? args[1] : args[0]) ?? '';
            const literals = [...codeExpr.matchAll(/'([A-Z][A-Z0-9_]{3,})'/g)].map((x) => x[1]);
            if (literals.length) {
                literalCalls++;
                for (const c of literals) {
                    if (!found.has(c)) found.set(c, new Set());
                    found.get(c)!.add(rel);
                }
                continue;
            }
            opaque.push(`${rel}\u0000${codeExpr}`);
        }
    }
    // Declared sites contribute their codes to the population.
    for (const [file, , codes] of DYNAMIC_CODE_SITES) {
        for (const c of codes) {
            if (!found.has(c)) found.set(c, new Set());
            found.get(c)!.add(file);
        }
    }
    return { codes: found, opaque: [...new Set(opaque)].sort(), literalCalls };
}

const bg = readCatalogue('bg') as {
    errors?: Record<string, unknown>;
};

/**
 * Where to ADD an entry, for the failure message — DERIVED, not written down.
 *
 * It said `messages/bg.json` until #1960 split the catalogue into bundles and
 * deleted that file, so the one line a developer reads when this guard fires
 * pointed at a path that no longer existed. `cataloguePath` exists for
 * exactly this ("the few tests that name the path rather than the
 * contents"), and deriving it means the next move cannot leave this stale.
 */
const BG_CATALOGUE = relative(REPO_ROOT, cataloguePath('bg'));
const ENTRIED = new Set(Object.keys(bg.errors ?? {}));
const scan = thrownCodes();
const thrown = scan.codes;
const unentried = [...thrown.keys()].filter((c) => !ENTRIED.has(c)).sort();
const excused = new Set([...DELIBERATELY_UNENTRIED.map(([c]) => c), ...BACKLOG]);

describe('a new refusal code ships with its Bulgarian entry (#1677)', () => {
    it('ranges over every thrown code — the denominators', () => {
        console.log(
            `[code-entry] ${thrown.size} code(s) thrown in src, ${thrown.size - unentried.length} entried, ` +
                `${unentried.length} not — ${BACKLOG.length} backlog + ${DELIBERATELY_UNENTRIED.length} deliberate` +
                ` | ${scan.literalCalls} call(s) with a readable code, ` +
                `${DYNAMIC_CODE_SITES.length} declared dynamic site(s)`,
        );
        // A floor, so a refactor that stops finding call sites fails loudly
        // instead of passing over an empty population.
        expect(thrown.size).toBeGreaterThan(150);
    });

    it('every call site whose code it cannot read is DECLARED — #2008', () => {
        // The assertion the old regex could not make. It read only a literal
        // first argument, so a code chosen by an expression was invisible and
        // "no dynamic sites" was indistinguishable from "dynamic sites I
        // cannot see". Ten codes were thrown with no entry and no BACKLOG
        // line, and nothing failed.
        //
        // EXACT, not a ceiling: a new opaque call site fails here until
        // someone names the codes it can throw, and a site that becomes
        // readable has to be deleted from the list rather than left to rot.
        // Same rule as BACKLOG and #1966's «имот» allowlist.
        const declared = DYNAMIC_CODE_SITES.map(([f, e]) => `${f}\u0000${e}`).sort();
        const pretty = (xs: readonly string[]) =>
            xs.map((x) => '  ' + x.replace('\u0000', '  ->  ')).join('\n');
        expect(pretty(scan.opaque)).toBe(pretty(declared));
    });

    it('a declared site contributes its codes to the population', () => {
        // Without this the declaration would be decorative: the point of
        // naming the codes is that they then face the entry requirement like
        // any literal one. `FARM_HANDLE_RESERVED` is the case that proves it —
        // thrown only through `verdict.code`, so before #2008 nothing asked
        // for its Bulgarian while the PHONE already had it.
        for (const [file, , codes] of DYNAMIC_CODE_SITES) {
            for (const c of codes) {
                expect(`${c} from ${file}: ${thrown.has(c)}`).toBe(`${c} from ${file}: true`);
            }
        }
        // And the pass-through declares none, so it adds nothing.
        const passthrough = DYNAMIC_CODE_SITES.find(([f]) => f.includes('spatial-import'));
        expect(passthrough?.[2]).toEqual([]);
    });

    it('a declared list is COMPLETE, derived from the helper it names', () => {
        // Without this the declaration is a wish. Mutation-proving the list
        // showed it: deleting a code from `transitionErrorCode`'s declaration
        // changed nothing, because the code already had an entry, so no
        // assertion noticed it had stopped being required.
        //
        // So the two helpers that RETURN codes are read at source and the
        // declaration must match exactly. `verdict.code` is covered the same
        // way through HANDLE_REFUSAL_MESSAGES, whose keys are what
        // `checkHandleShape` can refuse with.
        const derive = (file: string, from: string, to: string): string[] => {
            const src = readFileSync(join(REPO_ROOT, file), 'utf8');
            const start = src.indexOf(from);
            expect(`${file} contains ${from}`).toBe(`${file} contains ${from}`);
            expect(start).toBeGreaterThan(-1);
            const end = src.indexOf(to, start);
            // TWO forms, because the sources differ and the first version of
            // this check read only one: the switch helpers RETURN quoted
            // literals (`return 'ILLEGAL_TRANSITION';`) while
            // HANDLE_REFUSAL_MESSAGES uses UNQUOTED object keys
            // (`FARM_HANDLE_UNUSABLE: '…'`). Matching only quotes derived an
            // empty list for the third case and the comparison failed — which
            // is the right failure, but for the wrong reason.
            const body = src.slice(start, end === -1 ? undefined : end);
            const found = [
                ...[...body.matchAll(/'([A-Z][A-Z0-9_]{3,})'/g)].map((m) => m[1]),
                ...[...body.matchAll(/^\s*([A-Z][A-Z0-9_]{3,}):/gm)].map((m) => m[1]),
            ];
            return [...new Set(found)].sort();
        };
        const cases: ReadonlyArray<readonly [string, string, string, string]> = [
            [
                'src/app-layer/usecases/task.ts',
                'src/app-layer/domain/work-item-status.ts',
                'export function transitionErrorCode',
                '\n}',
            ],
            [
                'src/app-layer/usecases/contract.ts',
                'src/app-layer/domain/contract-status.ts',
                'export function contractTransitionErrorCode',
                '\n}',
            ],
            [
                'src/app-layer/usecases/public-farm-profile.ts',
                'src/app-layer/usecases/public-farm-profile.ts',
                'const HANDLE_REFUSAL_MESSAGES',
                '\n};',
            ],
        ];
        for (const [site, source, from, to] of cases) {
            const declared = [
                ...(DYNAMIC_CODE_SITES.find(([f]) => f === site)?.[2] ?? []),
            ].sort();
            expect(`${site}: ${derive(source, from, to).join(',')}`).toBe(
                `${site}: ${declared.join(',')}`,
            );
        }
    });

    it('a code in a MESSAGE is not read as a code — the second-arg control', () => {
        // `codedClientError(status, code, message)` puts the code SECOND, so
        // the scan reads argument two when argument one is a 3-digit status.
        // It must not do that otherwise, or an ALLCAPS token inside a message
        // becomes a phantom code — which is exactly the shape #1965 removed
        // from `Task is ${task.status}`.
        //
        // TREATMENT_ABANDONED is the real second-position code and must be
        // seen; PENDING_REVIEW is a status that has appeared in message text
        // and must not be.
        expect(thrown.has('TREATMENT_ABANDONED')).toBe(true);
        expect(thrown.has('PENDING_REVIEW')).toBe(false);
    });

    it('the detector sees a real code — the control it needs', () => {
        // Multi-line calls included: `MFA_CODE_INVALID` has its code on its
        // own line, and an earlier version of this scan missed exactly those.
        expect(thrown.has('TENANT_NOT_FOUND')).toBe(true);
        expect(thrown.has('MFA_CODE_INVALID')).toBe(true);
        expect(ENTRIED.has('TENANT_NOT_FOUND')).toBe(true);
        // And a code mentioned ONLY in spec prose is not "thrown".
        expect(thrown.has('THREAD_CLOSED')).toBe(false);
    });

    it('no NEW code lacks an entry', () => {
        const fresh = unentried
            .filter((c) => !excused.has(c))
            .map((c) => `  ${c} — thrown at ${[...thrown.get(c)!].join(', ')}, no errors.${c} in ${BG_CATALOGUE}`);
        expect(fresh.join('\n')).toBe('');
    });

    it('the BACKLOG is EMPTY — #1918 finished and cannot be reopened by a line', () => {
        // Deliberately separate from `no NEW code lacks an entry`, which
        // passes when a new code and its backlog entry land in the same diff.
        // This refuses that: the list is not a place to defer work any more.
        // If a code genuinely should not be entried, it belongs in
        // DELIBERATELY_UNENTRIED with a reason.
        expect(BACKLOG).toEqual([]);
    });

    it('both lists are exact — no name outlives what it excuses', () => {
        // A grandfathered name that has since been entried, or whose code is
        // gone, must be deleted. Otherwise the list accumulates slack until
        // it stops describing anything.
        const stale = [...excused]
            .filter((c) => !unentried.includes(c))
            .map((c) => `  ${c} — ${ENTRIED.has(c) ? 'now HAS an entry; delete it from the list' : 'no longer thrown anywhere; delete it'}`);
        expect(stale.sort().join('\n')).toBe('');
    });

    it('a deliberate exclusion carries a reason long enough to be one', () => {
        for (const [code, why] of DELIBERATELY_UNENTRIED) {
            // A one-word "why" is how a decision becomes folklore.
            expect(`${code}: ${why.length > 80}`).toBe(`${code}: true`);
        }
    });
});
