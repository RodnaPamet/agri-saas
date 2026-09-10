/**
 * Structural analysis of the `overrides` block — a PURE function of
 * `package.json` + `package-lock.json`, with no network and no clock.
 *
 * ## Why this is offline, and must stay offline
 *
 * The failure this exists to stop is a **decayed floor**: an `overrides`
 * entry written to exclude a vulnerable release that, months later, no
 * longer excludes it. `docs/dependency-policy.md` records three entries
 * re-floored on 2026-07-25 for exactly that reason, and #853 re-floored two
 * more six weeks later. Twice in six weeks is a class, not an accident.
 *
 * The obvious guard — ask the advisory database whether each floor still
 * covers its advisory — is the one thing this file must never do:
 *
 *   1. "This floor has decayed" is a statement about the GitHub Advisory
 *      Database **at time T**, not about the repo. It is not computable
 *      from these two files, so a guard that claims to compute it is lying
 *      about its own subject.
 *   2. A network call on the merge path fails OPEN on registry degradation.
 *      `scripts/audit-exemptions.mjs` exists because of that precise defect:
 *      npm's bulk advisory endpoint returns `200 {}` both for "no
 *      advisories" and for "package not recognised", so "found nothing" and
 *      "checked nothing" arrive as identical bytes.
 *   3. The advisory endpoint serves WITHDRAWN advisories. `affects=uuid@11.1.1`
 *      returns GHSA-qmq6-f8pr-cx5x, which is withdrawn as a duplicate — so a
 *      naive checker would have flagged this repo's one runtime security
 *      floor as decayed on the day it shipped.
 *
 * So this module answers a different, smaller, DECIDABLE question:
 * **does each override entry still do the structural job an override is
 * for?** A floor that points at nothing, cannot act, excludes nothing, or
 * quietly relaxes someone else's requirement is broken regardless of what
 * any advisory says — and every one of those is a pure function of the two
 * JSON files. `hono` and `@hono/node-server` are the worked example: they
 * guard packages that are absent from the lockfile, which makes them
 * invisible to `npm audit` AND to Dependabot, which is how they decayed
 * twice without anything going red.
 *
 * ## The four checks
 *
 * **A — no floor without a target.** Every top-level override key must have
 * at least one matching entry in the lockfile. An override over a package
 * that is not installed cannot be observed by any other tool in the repo.
 *
 * **B — no override that cannot act.** For `{parent: {child: range}}`, npm
 * applies the override only to `parent`'s own declared edge on `child`. So
 * the entry is inert if `parent` declares `child` in none of
 * `dependencies` / `peerDependencies` / `optionalDependencies`, or if every
 * copy of `child` that `parent` resolves to is `inBundle: true` (bundled
 * bytes ship inside the parent tarball; npm does not rewrite them).
 *
 * **C — no floor that isn't a floor.** For a literal-range override, if
 * every requester's declared range is ALREADY a `semver.subset` of the
 * override range, the override excludes nothing that was reachable. It is
 * decoration, and — worse — it reads in review as protection.
 *
 * **D — no silent widening.** The sharp one. Two shapes, both meaning "the
 * override admits a version the requester's own declared range excludes":
 *
 *   - RELAXATION — the override's minimum sits BELOW a requester's minimum,
 *     so npm may install something OLDER than the requester itself demands.
 *     A "security floor" that does this is a relaxation wearing a floor's
 *     clothes.
 *   - PIN-BREAK — a requester pinned an EXACT version and the override
 *     range excludes that exact version, so the pin can no longer be
 *     honoured.
 *
 *   Deliberately NOT reported: an override whose floor sits ABOVE a
 *   requester's caret range (`uuid@^11.1.1` over `next-auth`'s `^8.3.2`).
 *   That is what a security floor IS. Measured twice on 2026-09-10: the
 *   unrestricted reading — "flag any `!semver.subset(override, requester)`"
 *   — fires on 14 of the 39 entries in the pre-fix tree, and on 9 of the 34
 *   that remain after the @typescript-eslint / picomatch fix this branch is
 *   merged on top of. Both times that is every legitimate security floor in
 *   docs/dependency-policy.md — `uuid`, `protobufjs`, `valibot`, `picomatch`
 *   — plus the documented `next-auth` peer bridge, i.e. the rule would have
 *   to waive a quarter to a third of its own subject on day one. A rule that
 *   must waive that much of its subject teaches people to add waivers. The
 *   two shapes above are the subset of that reading which is never what an
 *   override is for.
 *
 * ## Failing safe
 *
 * Every semver comparison here is wrapped, and an unparseable range is
 * NEVER silently dropped: it is collected into `unparseableRanges` so the
 * guard can assert that list is empty. Both C and D fail toward green on a
 * range they cannot parse (C needs to prove ALL requesters are subsets; D
 * needs to prove a specific relation), which is exactly the shape that
 * rots into a tautology — so the guard treats a non-empty
 * `unparseableRanges` as a failure rather than as a shrug.
 *
 * **"Range" means BOTH sides of the comparison**, and until #866 it meant
 * only one. `unparseableRanges` was populated exclusively by
 * `requestersFor()`, i.e. for the ranges packages in the lockfile declare —
 * an override's OWN value was never examined. So the paragraph above was
 * false in the direction that matters most: writing
 * `"sharp": "not-a-parseable-range"` into package.json — a value npm cannot
 * apply at all — left both C and D `continue`-ing on `!isParseableRange`
 * with nothing recorded anywhere, and the whole guard green. The same hole
 * swallowed a `$name` reference pointing at a package the root does not
 * declare, whose `resolved` is null. `collectValueDefects()` below now
 * records both, BEFORE any check reasons about the edge, which is what
 * makes this section describe the code.
 */

interface SemverApi {
    validRange(range: string, opts?: { loose?: boolean }): string | null;
    valid(version: string, opts?: { loose?: boolean }): string | null;
    satisfies(version: string, range: string, opts?: { loose?: boolean }): boolean;
    intersects(a: string, b: string, opts?: { loose?: boolean }): boolean;
    subset(sub: string, dom: string, opts?: { loose?: boolean }): boolean;
    minVersion(range: string, opts?: { loose?: boolean }): { version: string } | null;
    lt(a: string, b: string, opts?: { loose?: boolean }): boolean;
}

// `semver` ships no bundled types and `@types/semver` is not installed;
// `require` + a narrow local interface keeps this typed without touching
// the dependency table (a lockfile change for four functions is not a
// trade worth making). The same idiom is used in
// tests/guards/coverage-parity-proof-current.test.ts.
const semver = require('semver') as SemverApi;

/** The three fields npm reads when deciding whether a package requests another. */
export const DECLARATION_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;

export type DeclarationField = (typeof DECLARATION_FIELDS)[number];

export interface LockEntry {
    version?: string;
    inBundle?: boolean;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
}

export interface Lockfile {
    packages?: Record<string, LockEntry>;
}

export type OverrideValue = string | { [child: string]: OverrideValue };

export interface PackageJson {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    overrides?: Record<string, OverrideValue>;
}

export type CheckId = 'A' | 'B' | 'C' | 'D';

export interface Finding {
    check: CheckId;
    /**
     * The waiver key. Deliberately built from the OVERRIDE entry
     * (`picomatch`, `npm > undici`) and never from a lockfile path — paths
     * churn on every hoist, and a waiver list keyed on them would go stale
     * on mechanical Dependabot bumps and train people to delete entries
     * without reading them.
     */
    target: string;
    detail: string;
}

export interface OverrideEdge {
    /** The `overrides` key exactly as written, e.g. `brace-expansion@^5`. */
    key: string;
    /** Package the override key names, with any `@<selector>` stripped. */
    name: string;
    /** The `@<range>` selector on the key, or null. */
    selector: string | null;
    /** Nested `{parent: {child}}` overrides name a parent; top-level ones do not. */
    parent: string | null;
    /** The package whose version this edge constrains. */
    child: string;
    /** The value as written — may be `$name`. */
    raw: string;
    /** `raw` with a `$name` reference resolved against the root package's own ranges. */
    resolved: string | null;
}

export interface Analysis {
    findings: Finding[];
    edges: OverrideEdge[];
    /**
     * Ranges no semver parse could make sense of — from BOTH sides: the
     * ranges requesters declare in the lockfile, and the `overrides` values
     * themselves (including a `$name` that resolves to nothing). MUST be
     * empty; see "## Failing safe" in the module docblock for the hole this
     * closes.
     */
    unparseableRanges: string[];
    /** Override keys nesting deeper than `{parent: {child: range}}`. */
    unsupportedNesting: string[];
}

/**
 * Split an `overrides` key into package name and optional version selector.
 *
 * The `@` that starts a scope is not a separator, which is why this uses
 * `lastIndexOf` with an `index > 0` guard: `@hono/node-server` has no
 * selector, `brace-expansion@^5` has `^5`, `@scope/pkg@^2` has `^2`.
 */
export function splitOverrideKey(key: string): { name: string; selector: string | null } {
    const at = key.lastIndexOf('@');
    if (at > 0) return { name: key.slice(0, at), selector: key.slice(at + 1) };
    return { name: key, selector: null };
}

function rootRanges(pkg: PackageJson): Record<string, string> {
    return { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
}

export function isParseableRange(range: unknown): range is string {
    return typeof range === 'string' && semver.validRange(range, { loose: true }) !== null;
}

function safeSubset(sub: string, dom: string): boolean | null {
    try {
        return semver.subset(sub, dom, { loose: true });
    } catch {
        return null;
    }
}

function safeMinVersion(range: string): string | null {
    try {
        return semver.minVersion(range, { loose: true })?.version ?? null;
    } catch {
        return null;
    }
}

function safeIntersects(a: string, b: string): boolean {
    try {
        return semver.intersects(a, b, { loose: true });
    } catch {
        // Cannot prove the selector excludes this edge, so KEEP the requester.
        // Dropping it would shrink the population a check reasons over, which
        // is the fail-toward-green direction.
        return true;
    }
}

/** Every lockfile entry that IS the named package, optionally filtered by a key selector. */
export function lockEntriesFor(lock: Lockfile, name: string, selector?: string | null): Array<[string, LockEntry]> {
    const suffix = `node_modules/${name}`;
    const all = Object.entries(lock.packages ?? {}).filter(
        ([path]) => path === suffix || path.endsWith(`/${suffix}`),
    );
    if (!selector) return all;
    return all.filter(([, entry]) => {
        if (!entry.version) return false;
        try {
            return semver.satisfies(entry.version, selector, { loose: true });
        } catch {
            return true;
        }
    });
}

/** The range at which `entry` requests `child`, and which field declared it. */
export function declaredRange(entry: LockEntry, child: string): { range: string; field: DeclarationField } | null {
    for (const field of DECLARATION_FIELDS) {
        const range = entry[field]?.[child];
        if (range) return { range, field };
    }
    return null;
}

/**
 * The copy of `child` that a package at `parentPath` actually resolves to.
 *
 * This is npm's own walk: try the parent's own `node_modules`, then each
 * enclosing one, then the root. Returns null when no copy exists anywhere
 * on that path.
 */
function resolveChildCopy(lock: Lockfile, parentPath: string, child: string): [string, LockEntry] | null {
    const packages = lock.packages ?? {};
    let dir = parentPath;
    for (;;) {
        const candidate = `${dir}${dir ? '/' : ''}node_modules/${child}`;
        if (packages[candidate]) return [candidate, packages[candidate]];
        const cut = dir.lastIndexOf('/node_modules/');
        if (cut < 0) {
            if (dir === '') return null;
            const root = `node_modules/${child}`;
            return packages[root] ? [root, packages[root]] : null;
        }
        dir = dir.slice(0, cut);
    }
}

interface Requester {
    path: string;
    range: string;
    field: DeclarationField;
}

/** Flatten the `overrides` block into one edge per (key, constrained package). */
export function overrideEdges(pkg: PackageJson): { edges: OverrideEdge[]; unsupportedNesting: string[] } {
    const edges: OverrideEdge[] = [];
    const unsupportedNesting: string[] = [];
    const roots = rootRanges(pkg);

    const resolve = (raw: string): string | null => (raw.startsWith('$') ? (roots[raw.slice(1)] ?? null) : raw);

    for (const [key, value] of Object.entries(pkg.overrides ?? {})) {
        const { name, selector } = splitOverrideKey(key);
        if (typeof value === 'string') {
            edges.push({ key, name, selector, parent: null, child: name, raw: value, resolved: resolve(value) });
            continue;
        }
        for (const [child, childValue] of Object.entries(value)) {
            if (child === '.') continue; // npm's "the package itself" key
            if (typeof childValue !== 'string') {
                // npm allows arbitrarily deep nesting. Nothing in this repo
                // uses it, and silently skipping a shape the analysis cannot
                // read is how a guard becomes decorative — so surface it.
                unsupportedNesting.push(`${key} > ${child}`);
                continue;
            }
            edges.push({
                key,
                name,
                selector,
                parent: name,
                child,
                raw: childValue,
                resolved: resolve(childValue),
            });
        }
    }
    return { edges, unsupportedNesting };
}

function edgeTarget(edge: OverrideEdge): string {
    return edge.parent ? `${edge.key} > ${edge.child}` : edge.key;
}

/**
 * Everything that requests `edge.child` under this override.
 *
 * For a nested override that is the parent alone (npm scopes a nested
 * override to the parent's own edge). For a top-level override it is every
 * package in the lockfile that declares the child — including the root
 * package, whose own ranges npm overrides too.
 */
function requestersFor(lock: Lockfile, edge: OverrideEdge, unparseable: string[]): Requester[] {
    const out: Requester[] = [];
    if (edge.parent) {
        for (const [path, entry] of lockEntriesFor(lock, edge.parent, edge.selector)) {
            const declared = declaredRange(entry, edge.child);
            if (!declared) continue;
            if (!isParseableRange(declared.range)) {
                unparseable.push(`${edgeTarget(edge)}: ${path} declares ${edge.child}@${declared.range}`);
                continue;
            }
            out.push({ path, ...declared });
        }
        return out;
    }
    for (const [path, entry] of Object.entries(lock.packages ?? {})) {
        const declared = declaredRange(entry, edge.child);
        if (!declared) continue;
        if (!isParseableRange(declared.range)) {
            unparseable.push(`${edgeTarget(edge)}: ${path || '<root>'} declares ${edge.child}@${declared.range}`);
            continue;
        }
        // A selector on the key (`brace-expansion@^5`) narrows the override to
        // instances matching it, so an edge that cannot resolve into that
        // range is not governed by this override at all.
        if (edge.selector && !safeIntersects(declared.range, edge.selector)) continue;
        out.push({ path: path || '<root>', ...declared });
    }
    return out;
}

/**
 * Record every override VALUE that is not a usable range.
 *
 * Two shapes, both of which npm silently declines to apply and neither of
 * which any of A/B/C/D reports:
 *
 *   - `resolved === null` — a `$name` reference to a package the root
 *     package does not declare in dependencies / devDependencies /
 *     optionalDependencies. `"sharp": "$sharp-typo"` is the injected form.
 *   - `resolved` is present but `semver.validRange` rejects it —
 *     `"sharp": "not-a-parseable-range"`, or a `$name` whose target range
 *     is itself garbage.
 *
 * Both go into `unparseableRanges`, which the guard asserts is empty.
 */
function collectValueDefects(edges: OverrideEdge[], unparseableRanges: string[]): void {
    for (const edge of edges) {
        if (edge.resolved === null) {
            unparseableRanges.push(
                `${edgeTarget(edge)}: override value "${edge.raw}" references a package the root ` +
                    'package does not declare, so npm resolves it to nothing',
            );
            continue;
        }
        if (!isParseableRange(edge.resolved)) {
            const via = edge.raw === edge.resolved ? '' : ` (via "${edge.raw}")`;
            unparseableRanges.push(
                `${edgeTarget(edge)}: override value "${edge.resolved}"${via} is not a range semver can parse`,
            );
        }
    }
}

/** Run all four checks. Pure: no fs, no network, no clock. */
export function analyseOverrides(pkg: PackageJson, lock: Lockfile): Analysis {
    const findings: Finding[] = [];
    const unparseableRanges: string[] = [];
    const { edges, unsupportedNesting } = overrideEdges(pkg);

    // FIRST, before any check looks at an edge: an override value npm cannot
    // apply is recorded rather than skipped. C and D both `continue` on
    // `!isParseableRange(edge.resolved)`, so without this the most broken
    // entry possible — a value that is not a range at all — is the one entry
    // no check reports. See "## Failing safe" in the module docblock.
    collectValueDefects(edges, unparseableRanges);

    // ── A — no floor without a target ────────────────────────────────────
    for (const key of Object.keys(pkg.overrides ?? {})) {
        const { name, selector } = splitOverrideKey(key);
        const matched = lockEntriesFor(lock, name, selector);
        if (matched.length > 0) continue;
        const anyVersion = lockEntriesFor(lock, name).length;
        findings.push({
            check: 'A',
            target: key,
            detail:
                `package-lock.json holds no entry for "${name}"` +
                (selector ? ` matching the key selector "${selector}" (${anyVersion} at any version)` : '') +
                '. An override over a package that is not installed is invisible to ' +
                'npm audit and to Dependabot, so nothing else in the repo can notice it decaying.',
        });
    }

    // ── B — no override that cannot act ──────────────────────────────────
    for (const edge of edges) {
        if (!edge.parent) continue;
        const parents = lockEntriesFor(lock, edge.parent, edge.selector);
        if (parents.length === 0) continue; // A already reported this key.

        const reasons: string[] = [];

        const declaring = parents.filter(([, entry]) => declaredRange(entry, edge.child) !== null);
        if (declaring.length === 0) {
            reasons.push(
                `"${edge.parent}" declares no dependency on "${edge.child}" in any of ` +
                    `${DECLARATION_FIELDS.join(' / ')} (checked ${parents.length} lockfile ` +
                    'copy/copies). npm scopes a nested override to the parent\'s OWN edge, ' +
                    'so there is no edge here for it to rewrite.',
            );
        }

        const copies = parents
            .map(([path]) => resolveChildCopy(lock, path, edge.child))
            .filter((c): c is [string, LockEntry] => c !== null);
        if (copies.length > 0 && copies.every(([, entry]) => entry.inBundle === true)) {
            reasons.push(
                `every "${edge.child}" copy that "${edge.parent}" resolves to is inBundle:true ` +
                    `(${copies.map(([p]) => p).join(', ')}). Bundled bytes ship inside the parent's ` +
                    'own tarball; npm installs them as published and does not apply the override to them.',
            );
        }

        if (reasons.length > 0) {
            findings.push({ check: 'B', target: edgeTarget(edge), detail: reasons.join(' ALSO: ') });
        }
    }

    // Requesters are computed ONCE per edge and shared by C and D. Computing
    // them twice also collected every unparseable range twice, which would
    // have made the "nothing was skipped silently" assertion report a
    // doubled, misleading count.
    const requestersByEdge = new Map<OverrideEdge, Requester[]>();
    for (const edge of edges) {
        requestersByEdge.set(edge, requestersFor(lock, edge, unparseableRanges));
    }

    // ── C — no floor that isn't a floor ──────────────────────────────────
    for (const edge of edges) {
        // `$name` entries are EXEMPT by construction, and the exemption is
        // load-bearing rather than convenient: `overrides.sharp === '$sharp'`
        // is the fix that
        // tests/guards/overrides-no-direct-dep-conflict.test.ts asserts
        // literally, after a repeated literal range aborted an entire
        // Dependabot run. A `$name` reference resolves to whatever the direct
        // dependency resolves to, so "does it exclude anything" is not even a
        // question about the override — it is a question about the direct
        // dependency's own range.
        if (edge.raw.startsWith('$')) continue;
        if (!edge.resolved || !isParseableRange(edge.resolved)) continue;

        const requesters = requestersByEdge.get(edge) ?? [];
        if (requesters.length === 0) continue; // A's business, not C's.

        const verdicts = requesters.map((r) => safeSubset(r.range, edge.resolved as string));
        if (!verdicts.every((v) => v === true)) continue;

        findings.push({
            check: 'C',
            target: edgeTarget(edge),
            detail:
                `every one of the ${requesters.length} requester range(s) is already a subset of ` +
                `"${edge.resolved}", so this override excludes no version anybody could have ` +
                `installed: ${requesters.map((r) => `${r.path} wants ${r.range}`).join('; ')}.`,
        });
    }

    // ── D — no silent widening ───────────────────────────────────────────
    for (const edge of edges) {
        if (!edge.resolved || !isParseableRange(edge.resolved)) continue;
        const override = edge.resolved;
        const overrideFloor = safeMinVersion(override);
        const relaxations: string[] = [];
        const pinBreaks: string[] = [];

        for (const requester of requestersByEdge.get(edge) ?? []) {
            // Entirely inside what the requester allows — the override can only
            // narrow, which is what an override is for.
            if (safeSubset(override, requester.range) === true) continue;

            const requesterFloor = safeMinVersion(requester.range);
            if (overrideFloor && requesterFloor && semver.lt(overrideFloor, requesterFloor)) {
                relaxations.push(
                    `${requester.path} requires ${edge.child}@${requester.range} [${requester.field}] ` +
                        `but this override's floor is ${overrideFloor}, BELOW it`,
                );
                continue;
            }
            if (
                semver.valid(requester.range, { loose: true }) &&
                !semver.satisfies(requester.range, override, { loose: true })
            ) {
                pinBreaks.push(
                    `${requester.path} pins ${edge.child}@${requester.range} [${requester.field}] exactly, ` +
                        `and "${override}" excludes that exact version`,
                );
            }
            // Anything else is an ordinary upward floor. Not reported — see the
            // module docblock for why the unrestricted reading was rejected.
        }

        if (relaxations.length === 0 && pinBreaks.length === 0) continue;
        findings.push({
            check: 'D',
            target: edgeTarget(edge),
            detail: [
                ...relaxations.map((r) => `RELAXATION: ${r}`),
                ...pinBreaks.map((p) => `PIN-BREAK: ${p}`),
            ].join(' | '),
        });
    }

    return { findings, edges, unparseableRanges, unsupportedNesting };
}

/** Stable identity of a finding, used to match it against a waiver. */
export function findingKey(finding: Pick<Finding, 'check' | 'target'>): string {
    return `${finding.check}:${finding.target}`;
}
