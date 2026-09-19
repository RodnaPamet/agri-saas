/**
 * v2-fu-2 — Create button uniformity ratchet.
 *
 * Asserts the positive contract for create-action buttons. Pairs
 * with `tests/guards/action-label-vocabulary.test.ts` (which owns
 * the BAN side — no legacy `New|Add|Create X` text).
 *
 * The convention (v2-fu-2):
 *   Every "create" button reads literally `+ <Singular Noun>` and
 *   uses `<Button variant="primary">` (default `size="md"` — h-9 px).
 *
 *   - The `+` IS the icon. No separate `<Plus>` component.
 *   - The variant is locked to `primary` so the `+` glyph is
 *     uniformly white-on-brand across every create button.
 *   - The size is locked to `md` (no `sm` / `xs`) so the pill
 *     height is constant.
 *
 * What this ratchet enforces
 *   1. JSX `<Button ...>+ <Word>...</Button>` must declare
 *      `variant="primary"`. Calls without an explicit variant
 *      inherit the default (`primary`) so they pass.
 *   2. The same buttons must NOT declare `size="sm"` or `size="xs"`
 *      — calls without an explicit size pass (default = `md`).
 *
 * Pairs with:
 *   - tests/guards/action-label-vocabulary.test.ts (BAN side)
 *   - src/components/ui/button-variants.ts (the variant catalogue)
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["src/app", "src/components"];

const EXEMPT_DIR_NAMES = new Set<string>([
    "node_modules",
    "__tests__",
    "__mocks__",
]);
const EXEMPT_FILE_PATTERNS: RegExp[] = [
    /\.test\.tsx?$/,
    /\.spec\.tsx?$/,
    /\.stories\.tsx?$/,
];

interface Hit {
    file: string;
    line: number;
    text: string;
    issue: string;
}

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(ROOT, full);
        const segments = rel.split(path.sep);
        if (segments.some((s) => EXEMPT_DIR_NAMES.has(s))) continue;
        if (EXEMPT_FILE_PATTERNS.some((rx) => rx.test(rel))) continue;
        if (entry.isDirectory()) out.push(...walk(full));
        else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) out.push(full);
    }
    return out;
}

/**
 * Multi-line + multi-tag scan for create-button-shaped JSX blocks.
 *
 * Strategy:
 *   1. Find any `+ <CapitalisedWord>` text node in the file (whether
 *      it's on its own line, inline `>+ X<`, or inside a string).
 *   2. Walk BACKWARDS up to ~6 lines looking for the most recent
 *      open tag of `<Button`, `<button`, or `<Link`. Capture the
 *      attribute substring between `<TagName` and the matching `>`.
 *      Attributes can span multiple lines.
 *   3. Skip JSX text inside the open-tag bracket (we only want the
 *      *children* text node).
 *   4. If the captured attrs contain `buttonVariants(` (for `<Link>`
 *      / `<button>`) or the tag is `<Button` (CVA primitive), it's a
 *      create-button site. Yield the attrs for variant/size checks.
 */
interface CreateBtnHit {
    line: number;
    text: string;
    tagAttrs: string;
}

function findCreateButtons(content: string): CreateBtnHit[] {
    const lines = content.split("\n");
    const out: CreateBtnHit[] = [];
    // The `+ Word` text matcher. We require the `+` to be on its
    // own (preceded by start-of-line/whitespace/quote/`>`) and the
    // word to be capitalised. Skip lines that are clearly comments
    // or include "(New|Add|Create) X" — those are picked up by
    // action-label-vocabulary.
    const TEXT_RE =
        /(?:^|['"`>\s])\+\s+([A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*){0,3})/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*"))
            continue;
        if (!TEXT_RE.test(line)) continue;
        // Skip the legacy-verb form (handled by the other ratchet).
        if (/\+\s+(New|Add|Create)\s+/.test(line)) continue;

        // Walk back up to 6 lines for the most recent open tag.
        let openLineIdx = -1;
        let openMatch: RegExpExecArray | null = null;
        for (
            let j = i;
            j >= Math.max(0, i - 6) && openMatch === null;
            j--
        ) {
            const re = /<([Bb]utton|Link)\b/g;
            let m: RegExpExecArray | null = null;
            let last: RegExpExecArray | null = null;
            while ((m = re.exec(lines[j])) !== null) last = m;
            if (last) {
                openLineIdx = j;
                openMatch = last;
            }
        }
        if (!openMatch) continue;

        // Build the attribute substring from `<TagName` to the next `>`
        // — possibly spanning multiple lines.
        let attrs = "";
        let foundClose = false;
        const startIdx = openMatch.index + openMatch[0].length;
        for (let j = openLineIdx; j <= i && !foundClose; j++) {
            const segment =
                j === openLineIdx ? lines[j].slice(startIdx) : lines[j];
            const closeIdx = segment.indexOf(">");
            if (closeIdx >= 0) {
                attrs += segment.slice(0, closeIdx);
                foundClose = true;
            } else {
                attrs += segment + " ";
            }
        }
        if (!foundClose) continue;

        const tagName = openMatch[1];
        // For `<Link>` / `<button>`, only count it as a create-button
        // if the attrs reference `buttonVariants(...)` (otherwise
        // it's just a plain link/button).
        if (tagName !== "Button" && !/buttonVariants\s*\(/.test(attrs))
            continue;

        out.push({
            line: i + 1,
            text: trimmed.slice(0, 200),
            tagAttrs: attrs,
        });
    }
    return out;
}

describe("v2-fu-2 create-button uniformity", () => {
    // ── Controls (#971) ──────────────────────────────────────────────
    //
    // Both ratchets in this file are `for (const file of walk(...))`
    // loops that collect offenders and assert there are none, so a
    // `walk` returning nothing reports a clean create-button surface
    // having opened no files at all. `selector-teeth` gutted it to a
    // constant and NOTHING here failed.
    //
    // The `scan root does not exist` throw above cannot see that. It
    // fires only when a root is RENAMED; a walk that returns [] over two
    // roots that both exist — an over-matching exemption, a typo in the
    // extension test — sails straight past it.
    //
    // Measured at this commit: src/app 584 files, src/components 688
    // (826 .tsx + 446 .ts). The floors sit far below both, so ordinary
    // feature PRs never move them, but a root going dark cannot hide.
    it("control: walk returns a real population for EVERY scan root", () => {
        const perRoot = new Map(
            SCAN_DIRS.map((dir) => [dir, walk(path.join(ROOT, dir))] as const),
        );
        // Per root, never a combined total: one root going dark is
        // invisible in a sum the other root still carries.
        const appFiles = perRoot.get("src/app") ?? [];
        const componentFiles = perRoot.get("src/components") ?? [];
        expect(appFiles.length).toBeGreaterThan(300); // measured 584
        expect(componentFiles.length).toBeGreaterThan(400); // measured 688
        // …and walk answers the argument it was GIVEN, so one fixed list
        // returned for every root cannot satisfy both floors.
        expect(
            appFiles.every((f) =>
                f.startsWith(path.join(ROOT, "src/app") + path.sep),
            ),
        ).toBe(true);
        expect(
            componentFiles.every((f) =>
                f.startsWith(path.join(ROOT, "src/components") + path.sep),
            ),
        ).toBe(true);

        const all = [...appFiles, ...componentFiles];
        expect(all.every((f) => path.isAbsolute(f))).toBe(true);
        expect(all.every((f) => /\.(tsx|ts|jsx|js)$/.test(f))).toBe(true);
        // Recursion reaches the primitive this ratchet is ABOUT.
        expect(all.map((f) => path.relative(ROOT, f))).toContain(
            "src/components/ui/button.tsx",
        );
    });

    it("control: walk's exclusions bite on real files", () => {
        const rel = SCAN_DIRS.flatMap((dir) =>
            walk(path.join(ROOT, dir)).map((f) => path.relative(ROOT, f)),
        );
        // A real file the exemptions must be REMOVING — asserted to exist
        // first, so "excluded" can never quietly mean "never there".
        const excluded =
            "src/components/ui/hooks/__tests__/use-toast-with-undo.test.ts";
        expect(fs.existsSync(path.join(ROOT, excluded))).toBe(true);
        expect(rel).not.toContain(excluded);
        for (const name of EXEMPT_DIR_NAMES) {
            expect(rel.filter((r) => r.split(path.sep).includes(name))).toEqual(
                [],
            );
        }
        expect(
            rel.filter((r) => EXEMPT_FILE_PATTERNS.some((rx) => rx.test(r))),
        ).toEqual([]);
    });

    it("zero `+ X` buttons declare a non-primary variant", () => {
        const offenders: Hit[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.join(ROOT, dir))) {
                const content = fs.readFileSync(file, "utf8");
                for (const hit of findCreateButtons(content)) {
                    const variantMatch = hit.tagAttrs.match(
                        /variant\s*[:=]\s*["']([a-z-]+)["']/,
                    );
                    if (
                        variantMatch &&
                        variantMatch[1] !== "primary"
                    ) {
                        offenders.push({
                            file: path.relative(ROOT, file),
                            line: hit.line,
                            text: hit.text,
                            issue: `variant="${variantMatch[1]}" — must be variant="primary"`,
                        });
                    }
                }
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 15)
                .map(
                    (o) =>
                        `  ${o.file}:${o.line}  [${o.issue}]\n    ${o.text}`,
                )
                .join("\n");
            throw new Error(
                `Found ${offenders.length} create-button(s) with non-primary variant. The '+' glyph must render uniformly white-on-brand across every create button — keep the variant locked to 'primary'.\n\nFirst ${Math.min(15, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    // ── Controls (#971) ──────────────────────────────────────────────
    //
    // `findCreateButtons` is the detector both ratchets run over every
    // scanned file, and TODAY IT FINDS NOTHING: measured at this commit,
    // 0 hits across all 1,272 scanned files, because the paired BAN
    // ratchet (action-label-vocabulary) has removed every literal
    // `+ <Noun>` label from the product. So gutting it to `[]` changed no
    // result — a probe that could not mutate, not a guard that failed to
    // notice.
    //
    // That is exactly why it needs a control. With no live input, nothing
    // in this file proves the detector still WORKS: TEXT_RE could stop
    // matching, the six-line backward walk could stop finding open tags,
    // the `tagAttrs` capture could come back empty — and both ratchets
    // would stay green while the uniformity contract goes unenforced the
    // moment a `+ X` button returns.
    //
    // There is no positive control to be had against real source: the
    // measured number of real matches is zero. So the mechanism is driven
    // on planted source, and `tagAttrs` is pinned too — a detector
    // returning hits with empty attrs would satisfy a count-only check
    // while handing the variant / size regexes nothing to match.
    it("control: findCreateButtons finds planted create buttons", () => {
        const singleLine = findCreateButtons(
            `        <Button variant="secondary">+ Asset</Button>`,
        );
        expect(singleLine).toHaveLength(1);
        expect(singleLine[0]?.tagAttrs ?? "").toContain(`variant="secondary"`);

        // The size axis the sibling ratchet matches on.
        const sized = findCreateButtons(
            `        <Button size="sm">+ Asset</Button>`,
        );
        expect(sized).toHaveLength(1);
        expect(sized[0]?.tagAttrs ?? "").toContain(`size="sm"`);

        // Attributes spanning the documented six-line backward walk.
        const multiLine = findCreateButtons(
            [
                "                <Button",
                `                    variant="ghost"`,
                "                    onClick={fn}",
                ">",
                "                    + Asset",
                "                </Button>",
            ].join("\n"),
        );
        expect(multiLine).toHaveLength(1);
        expect(multiLine[0]?.line).toBe(5);
        expect(multiLine[0]?.tagAttrs ?? "").toContain(`variant="ghost"`);

        // `<Link>` counts only via buttonVariants(...) — the documented
        // rule for the non-primitive tags.
        const link = findCreateButtons(
            `        <Link href="/x" className={buttonVariants({ variant: "secondary" })}>+ Field</Link>`,
        );
        expect(link).toHaveLength(1);
        expect(link[0]?.tagAttrs ?? "").toContain("buttonVariants(");
    });

    it("control: findCreateButtons ignores the documented near-misses", () => {
        // A plain link / button is not a create button: no buttonVariants.
        expect(findCreateButtons(`        <Link href="/x">+ Field</Link>`)).toEqual(
            [],
        );
        expect(
            findCreateButtons(`        <button className="x">+ Field</button>`),
        ).toEqual([]);
        // Commented-out source, both comment shapes.
        expect(
            findCreateButtons(
                `        // <Button variant="secondary">+ Asset</Button>`,
            ),
        ).toEqual([]);
        expect(
            findCreateButtons(
                `         * <Button variant="secondary">+ Asset</Button>`,
            ),
        ).toEqual([]);
        // The legacy verb form belongs to action-label-vocabulary.
        for (const verb of ["New", "Add", "Create"]) {
            expect(
                findCreateButtons(
                    `        <Button variant="secondary">+ ${verb} Asset</Button>`,
                ),
            ).toEqual([]);
        }

        // Real source, and the denominator that makes the zero mean
        // something: the scanned population is full of the `+ <Capitalised>`
        // text shape — docblock prose and arithmetic such as
        // `Math.abs(dx) + Math.abs(dy)`. Measured at this commit: 125 such
        // lines across 100 files, 95 of them comment-prefixed, and 0 hits.
        // So the comment filter and the open-tag lookback are load-bearing
        // on real input, not just on the planted strings above.
        const TEXT_SHAPE = /(?:^|['"`>\s])\+\s+[A-Z][A-Za-z]*/;
        const nearMiss = SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)))
            .map((f) => ({
                file: path.relative(ROOT, f),
                content: fs.readFileSync(f, "utf8"),
            }))
            .filter(({ content }) =>
                content.split("\n").some((l) => TEXT_SHAPE.test(l)),
            );
        expect(nearMiss.length).toBeGreaterThan(30); // measured 100
        // If THIS ever fails, a literal `+ <Noun>` label has come back:
        // that is news for action-label-vocabulary, not a reason to
        // weaken the control.
        expect(
            nearMiss
                .filter(({ content }) => findCreateButtons(content).length > 0)
                .map(({ file }) => file),
        ).toEqual([]);
    });

    it("zero `+ X` buttons declare size='sm' or size='xs'", () => {
        const offenders: Hit[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.join(ROOT, dir))) {
                const content = fs.readFileSync(file, "utf8");
                for (const hit of findCreateButtons(content)) {
                    const sizeMatch = hit.tagAttrs.match(
                        /size\s*[:=]\s*["'](xs|sm)["']/,
                    );
                    if (sizeMatch) {
                        offenders.push({
                            file: path.relative(ROOT, file),
                            line: hit.line,
                            text: hit.text,
                            issue: `size="${sizeMatch[1]}" — drop the prop (default 'md' is the canonical pill height)`,
                        });
                    }
                }
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 15)
                .map(
                    (o) =>
                        `  ${o.file}:${o.line}  [${o.issue}]\n    ${o.text}`,
                )
                .join("\n");
            throw new Error(
                `Found ${offenders.length} create-button(s) with size='xs' or 'sm'. Pill height must be uniform — drop the prop so the default 'md' (h-9) applies.\n\nFirst ${Math.min(15, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });
});
