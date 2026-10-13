/**
 * Emit `src/generated/error-codes.json` — which error codes each path template
 * can return, as an APPEND-ONLY ledger. Proposed by `agrent-ios` in #1662.
 *
 * ## Why this file exists
 *
 * #1645 converted five refusals from `forbidden('CODE')` to
 * `codedForbidden('CODE', 'English sentence.')` — strictly right for
 * `error.code`, and it would have regressed three of them to English on the
 * phone. `UserMessage.httpText` falls through to `error.message` when it has no
 * entry for a code and that message reads as a human sentence, so the BARE
 * TOKEN had been load-bearing by accident.
 *
 * Neither side could have caught it. This repo cannot see the client's
 * catalogue, and the client's test covers the codes its author listed BY HAND —
 * so a code it has never heard of still ships as English. This file is the
 * artifact that closes that: a test on the client fails for any code on any
 * route that build touches, rather than for the codes somebody remembered.
 *
 * The same channel as the route inventory (#1087), for the same reason:
 * `scripts/refresh-agri-saas-routes.sh` already pulls that file.
 *
 * ## What `codes` means, and the direction it errs
 *
 * **An OVER-APPROXIMATION, deliberately.** A route is credited with every code
 * reachable through its transitive local imports — not with the codes its own
 * control flow can actually produce. `getTenantCtx` alone pulls in a dozen
 * modules, and a usecase that throws six codes contributes all six to any route
 * that imports it, even where only one is reachable.
 *
 * That is the safe direction for the question the client is asking. "Which
 * codes must I have copy for" wants a superset: a code listed and never seen
 * costs one unnecessary translation, and a code seen and never listed costs a
 * farmer an English sentence. It is the wrong direction for "which codes will
 * this route return", and no reader should use it for that — hence the
 * `_README` saying so inside the artifact, where a client author will see it.
 *
 * Resolving the narrower question means per-branch analysis of every handler.
 * That is a different tool, and this one should not pretend to be it.
 *
 * ## Append-only, and why the generator will not retire anything
 *
 * Same rule as `generate-route-inventory.ts`, for the same reason: a ledger
 * regenerated wholesale makes a REMOVAL exactly as cheap as an addition, which
 * is the defect it exists to prevent. A code that stops being emitted is
 * either a deliberate retirement — which costs a human a line in
 * `retiredCodes` saying what replaced it — or an accident that should fail
 * loudly.
 *
 * So: this script ADDS codes that appeared and RESURRECTS a retired code that
 * came back. It NEVER retires one. `tests/guards/error-codes-ledger.test.ts`
 * is the server half.
 *
 *     npm run errors:inventory
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { NON_SURFACE_ROUTE_FILES, ROOT, routeFiles, toOpenApiPath } from './lib/api-routes';

const OUT_REL = 'src/generated/error-codes.json';

/**
 * The code each UNCODED helper produces.
 *
 * `badRequest('…')` carries no code argument, and the envelope still ships
 * one — `ValidationError` sets `VALIDATION_ERROR`. A client switching on
 * `error.code` sees these far more often than any specific code (520 call
 * sites as of #1712), so omitting them would make the ledger describe the rare
 * case and not the common one.
 */
const UNCODED_HELPER_CODES: Readonly<Record<string, string>> = {
    badRequest: 'VALIDATION_ERROR',
    unprocessable: 'VALIDATION_ERROR',
    notFound: 'NOT_FOUND',
    forbidden: 'FORBIDDEN',
    conflict: 'CONFLICT',
    unauthorized: 'UNAUTHORIZED',
};

/** `codedX('CODE'` — the explicit form. */
const CODED_CALL = /\bcoded[A-Z][A-Za-z]*\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g;
/** An uncoded helper actually CALLED, not merely imported. */
const uncodedCall = (name: string) => new RegExp(`\\b${name}\\(`);

export interface RouteCodes {
    path: string;
    codes: string[];
    /** Required when a code leaves: what happened to it, and what replaced it. */
    retiredCodes?: Array<{ code: string; reason: string }>;
}

interface Ledger {
    _README: string[];
    routes: RouteCodes[];
}

const README = [
    'Which error codes each path template can return. APPEND-ONLY.',
    '',
    'OVER-APPROXIMATION: a route is credited with every code reachable through',
    'its transitive local imports, NOT with the codes its own control flow can',
    'produce. Use this to answer "which codes must I have copy for" — a',
    'superset is the safe answer to that. Do NOT use it to predict what a',
    'given call will return.',
    '',
    'The generator ADDS and never retires. A code that stops being emitted',
    'stays here and fails the guard until a human moves it to `retiredCodes`',
    'with a reason. See scripts/generate-error-codes.ts.',
    '',
    'An EMPTY `codes` array means the route does not speak this error envelope',
    'at all — NOT that it cannot fail. The 16 such paths are liveness probes',
    '(/health, /livez, /readyz, /metrics), machine endpoints (stripe and AV',
    'webhooks, csp-report), /auth/verify-email which REDIRECTS rather than',
    'answering, and the SCIM surface, which returns RFC 7644 `scimError`',
    'objects with their own `scimType` instead of `error.code`. A client must',
    'not read [] as "no error handling needed here".',
];

/** Resolve one import specifier to a file under `src/`, or null. */
function resolveLocal(spec: string, fromFile: string): string | null {
    let rel: string;
    if (spec.startsWith('@/')) rel = path.join('src', spec.slice(2));
    else if (spec.startsWith('./') || spec.startsWith('../')) {
        rel = path.join(path.dirname(fromFile), spec);
    } else return null; // a package, not ours

    for (const candidate of [
        `${rel}.ts`,
        `${rel}.tsx`,
        path.join(rel, 'index.ts'),
        path.join(rel, 'index.tsx'),
        rel,
    ]) {
        const abs = path.join(ROOT, candidate);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
            return path.relative(ROOT, abs);
        }
    }
    return null;
}

const IMPORT_SPEC = /(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]/g;

/** Codes emitted by one module's own source. */
function codesIn(src: string): Set<string> {
    const out = new Set<string>();
    for (const m of src.matchAll(CODED_CALL)) out.add(m[1]);
    for (const [helper, code] of Object.entries(UNCODED_HELPER_CODES)) {
        if (uncodedCall(helper).test(src)) out.add(code);
    }
    return out;
}

/** Every code reachable from `entry` through local imports. Cycle-safe. */
function reachableCodes(entry: string, cache: Map<string, Set<string>>): Set<string> {
    const out = new Set<string>();
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length) {
        const file = stack.pop() as string;
        if (seen.has(file)) continue;
        seen.add(file);

        const cached = cache.get(file);
        if (cached) {
            for (const c of cached) out.add(c);
            continue;
        }
        const abs = path.join(ROOT, file);
        if (!fs.existsSync(abs)) continue;
        const src = fs.readFileSync(abs, 'utf8');
        for (const c of codesIn(src)) out.add(c);
        for (const m of src.matchAll(IMPORT_SPEC)) {
            const next = resolveLocal(m[1], file);
            if (next && !seen.has(next)) stack.push(next);
        }
    }
    return out;
}

function load(abs: string): Ledger {
    if (!fs.existsSync(abs)) return { _README: README, routes: [] };
    const raw = JSON.parse(fs.readFileSync(abs, 'utf8')) as Ledger;
    return { _README: README, routes: raw.routes ?? [] };
}

function main(): void {
    const outAbs = path.join(ROOT, OUT_REL);
    const previous = load(outAbs);
    const prior = new Map(previous.routes.map((r) => [r.path, r]));

    const cache = new Map<string, Set<string>>();
    const live = new Map<string, Set<string>>();
    for (const file of routeFiles()) {
        if (NON_SURFACE_ROUTE_FILES.has(file)) continue;
        const template = toOpenApiPath(file);
        const codes = reachableCodes(file, cache);
        const existing = live.get(template);
        if (existing) for (const c of codes) existing.add(c);
        else live.set(template, codes);
    }

    const paths = new Set<string>([...live.keys(), ...prior.keys()]);
    const routes: RouteCodes[] = [];
    let added = 0;
    let resurrected = 0;

    for (const p of [...paths].sort()) {
        const was = prior.get(p);
        const now = live.get(p) ?? new Set<string>();
        const retired = was?.retiredCodes ?? [];

        // ADD: anything newly emitted. RESURRECT: a retired code that is back.
        const kept = new Set<string>(was?.codes ?? []);
        const stillRetired: Array<{ code: string; reason: string }> = [];
        for (const r of retired) {
            if (now.has(r.code)) { kept.add(r.code); resurrected += 1; }
            else stillRetired.push(r);
        }
        for (const c of now) {
            if (!kept.has(c)) { kept.add(c); added += 1; }
        }

        const entry: RouteCodes = { path: p, codes: [...kept].sort() };
        if (stillRetired.length) entry.retiredCodes = stillRetired;
        routes.push(entry);
    }

    const next: Ledger = { _README: README, routes };
    fs.writeFileSync(outAbs, `${JSON.stringify(next, null, 2)}\n`);

    const total = routes.reduce((n, r) => n + r.codes.length, 0);
    console.log(`[error-codes] ${OUT_REL}`);
    console.log(`[error-codes] paths ${routes.length}   code entries ${total}`);
    console.log(`[error-codes] added ${added}   resurrected ${resurrected}`);
    const distinct = new Set(routes.flatMap((r) => r.codes));
    console.log(`[error-codes] distinct codes ${distinct.size}`);
}

main();
