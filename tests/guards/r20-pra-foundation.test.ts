/**
 * R20-PR-A — Liquid Elegance foundation ratchet.
 *
 * Roadmap-20 takes the R19 carbon button system three steps further:
 *   • PR-A — foundation: new tokens + form-control parity scaffold.
 *   • PR-B — liquid edges: iridescent border + soft diffusion.
 *   • PR-C — airy density: padding scale + letter-spacing.
 *   • PR-D — tactile press: ambient shadow shift + capstone.
 *
 * PR-A's job is to land the LANGUAGE pieces — every following PR
 * consumes them. The token names, the gradient string shape, the
 * presence of a `control-variants.ts` scaffold for form-control
 * parity, the per-theme dark+light coverage — every following PR
 * builds on this surface, so we lock it structurally here. A
 * future "simplify" pass that strips an unused token would break
 * this ratchet first, forcing the conversation.
 *
 * What PR-A delivers:
 *   1. Four ambient-elevation tokens (rest / hover / press / focus)
 *      defined in BOTH theme blocks (dark `:root`, light `[data-theme="light"]`).
 *   2. An iridescent-edge gradient token in both themes — a linear
 *      gradient sweeping from brand to secondary, low-alpha,
 *      consumed by PR-B as a `border-image` source.
 *   3. An aura-wash token pair (primary + neutral) in both themes —
 *      pre-composed multi-stop box-shadow strings, consumed by
 *      PR-B as the `::after` halo for hover.
 *   4. Three form-control parity edge tokens (rest / hover / focus)
 *      in both themes.
 *   5. A `src/components/ui/control-variants.ts` file exporting
 *      `controlEdge`, `controlSize`, and a `controlVariants` cva.
 *      The control sizing scale mirrors the button sizing scale so
 *      paired-row layouts (filter toolbar) align.
 *
 *      #776 collapsed BOTH scales onto a single 28px rung, so
 *      "mirrors" now means "resolves to the same one rung" rather
 *      than "walks the same four-rung ladder". The parity block at
 *      the bottom of this file was retargeted accordingly, and the
 *      ladder it used to walk is recorded there rather than dropped.
 *
 * WHAT THIS FILE PROVES. Every assertion below reads source TEXT
 * with `readFileSync` and a regex. Nothing here renders a button, an
 * input, or a toolbar row, so this suite contributes zero runtime
 * coverage and cannot observe a computed height — it proves the two
 * modules AGREE IN SOURCE. See the parity block's own caveat for why
 * that agreement is currently weaker than its name suggests.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const TOKENS = fs.readFileSync(
    path.join(ROOT, "src/styles/tokens.css"),
    "utf8",
);
const BUTTON_VARIANTS = fs.readFileSync(
    path.join(ROOT, "src/components/ui/button-variants.ts"),
    "utf8",
);
const CONTROL_VARIANTS = fs.readFileSync(
    path.join(ROOT, "src/components/ui/control-variants.ts"),
    "utf8",
);

/**
 * Slice the contents of one theme block (`:root { … }` for dark or
 * `[data-theme="light"] { … }` for light) so we can assert that a
 * given token appears INSIDE the right block, not in some other
 * theme's block.
 */
function themeBlock(selector: string): string {
    const start = TOKENS.indexOf(selector);
    if (start === -1) return "";
    // Find the matching closing brace by counting depth from the
    // first `{` after the selector.
    const open = TOKENS.indexOf("{", start);
    if (open === -1) return "";
    let depth = 1;
    let i = open + 1;
    while (i < TOKENS.length && depth > 0) {
        if (TOKENS[i] === "{") depth++;
        else if (TOKENS[i] === "}") depth--;
        i++;
    }
    return TOKENS.slice(open + 1, i - 1);
}

const DARK = themeBlock(":root");
// The light theme selector in this codebase is `[data-theme="light"]`.
const LIGHT = themeBlock('[data-theme="light"]');

/**
 * Brace-balanced slice of the object literal that opens at the first
 * `{` after `marker` — the same depth-counting trick as `themeBlock`,
 * pointed at a TypeScript source instead of CSS.
 */
function objectBody(source: string, marker: RegExp): string {
    const m = marker.exec(source);
    if (!m) return "";
    const open = source.indexOf("{", m.index);
    if (open === -1) return "";
    let depth = 1;
    let i = open + 1;
    while (i < source.length && depth > 0) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") depth--;
        i++;
    }
    return source.slice(open + 1, i - 1);
}

/**
 * Drop `//` and block comments before matching size keys. Both size
 * maps carry long prose INSIDE the literal — the button one narrates
 * four roadmap passes of density tuning by size key — so stripping
 * comments first is what stops `xs:` from matching a sentence about
 * `xs` instead of the entry named `xs`.
 */
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Resolve one size key to the class string it ultimately names.
 *
 * A value is written either inline (`xs: "h-7 …"` — button-variants)
 * or as a bare identifier pointing at a shared constant
 * (`xs: CONTROL_RUNG` — control-variants, which is how the #776
 * collapse is spelled there). The identifier branch follows the const
 * back to its string so both files answer in the same currency, and
 * returns "" when it cannot, so an unresolvable name reads as a MISS
 * rather than as a match.
 */
function rungFor(source: string, body: string, key: string): string {
    const m = new RegExp(
        `(?:^|[\\s,{])${key}\\s*:\\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z_$][\\w$]*))`,
    ).exec(body);
    if (!m) return "";
    if (m[1] !== undefined) return m[1];
    if (m[2] !== undefined) return m[2];
    const decl = new RegExp(
        `\\b(?:const|let|var)\\s+${m[3]}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    ).exec(source);
    return decl ? (decl[1] ?? decl[2] ?? "") : "";
}

/** First `h-…` utility in a rung, or "" if the rung declares no height. */
function heightOf(rung: string): string {
    return /(?:^|\s)(h-\S+)/.exec(rung)?.[1] ?? "";
}

/** The four ladder keys. `icon` is square and out of scope here. */
const LADDER_KEYS = ["xs", "sm", "md", "lg"] as const;

const BUTTON_SIZE_BODY = stripComments(
    objectBody(BUTTON_VARIANTS, /^\s*size:\s*\{/m),
);
const CONTROL_SIZE_BODY = stripComments(
    objectBody(CONTROL_VARIANTS, /export\s+const\s+controlSize\s*=\s*\{/),
);

const BUTTON_RUNGS = LADDER_KEYS.map((k) =>
    rungFor(BUTTON_VARIANTS, BUTTON_SIZE_BODY, k),
);
const CONTROL_RUNGS = LADDER_KEYS.map((k) =>
    rungFor(CONTROL_VARIANTS, CONTROL_SIZE_BODY, k),
);

/** The one height both families collapsed onto in #776. */
const COLLAPSED_HEIGHT = "h-7";

describe("R20-PR-A — Liquid Elegance foundation", () => {
    describe("ambient-elevation tokens — both themes carry the four-stop scale", () => {
        for (const token of [
            "--btn-ambient-rest",
            "--btn-ambient-hover",
            "--btn-ambient-press",
            "--btn-ambient-focus",
        ]) {
            it(`${token} is defined in the dark theme block`, () => {
                expect(DARK).toMatch(new RegExp(`${token}:`));
            });
            it(`${token} is defined in the light theme block`, () => {
                expect(LIGHT).toMatch(new RegExp(`${token}:`));
            });
        }

        it("rest carries the soft two-stop drop shape", () => {
            // The shape is two box-shadow stops: a tight close drop +
            // a wider soft halo. Asserting just the COUNT keeps the
            // ratchet from over-specifying alphas (those are tunable).
            for (const block of [DARK, LIGHT]) {
                const m = block.match(/--btn-ambient-rest:\s*([^;]+);/);
                expect(m).toBeTruthy();
                // Two box-shadow stops separated by a comma.
                expect((m![1].match(/rgba\(/g) ?? []).length).toBe(2);
            }
        });

        it("press collapses to a single tight stop", () => {
            // Pressed = surface pushed INTO the page; less light
            // leaks out. One stop, not two.
            for (const block of [DARK, LIGHT]) {
                const m = block.match(/--btn-ambient-press:\s*([^;]+);/);
                expect(m).toBeTruthy();
                expect((m![1].match(/rgba\(/g) ?? []).length).toBe(1);
            }
        });

        it("focus stacks the brand-tinted ring ON TOP of the rest drop", () => {
            // Focus must carry a brand ring stop PLUS the rest
            // drop's two stops, totalling 3 stops. R22-PR-B
            // tightened the ring from 4px → 3px to match the
            // form-control `--ctrl-edge-focus` shape — focused
            // button + focused input now wear the same halo
            // geometry.
            for (const block of [DARK, LIGHT]) {
                const m = block.match(/--btn-ambient-focus:\s*([^;]+);/);
                expect(m).toBeTruthy();
                expect(m![1]).toMatch(/0 0 0 3px/);
                expect((m![1].match(/rgba\(/g) ?? []).length).toBe(3);
            }
        });
    });

    describe("iridescent-edge gradient — present in both themes", () => {
        it("is a linear gradient at 135deg in the dark theme", () => {
            expect(DARK).toMatch(/--btn-iridescent-gradient:\s*linear-gradient\(135deg/);
        });
        it("is a linear gradient at 135deg in the light theme", () => {
            expect(LIGHT).toMatch(/--btn-iridescent-gradient:\s*linear-gradient\(135deg/);
        });
        it("sweeps from brand to secondary (4 stops)", () => {
            // The gradient is a brand→secondary sweep, two whisper
            // mid-stops keeping the visible band soft. Four stops.
            for (const block of [DARK, LIGHT]) {
                const m = block.match(
                    /--btn-iridescent-gradient:\s*linear-gradient\(135deg,([^;]+)\);/,
                );
                expect(m).toBeTruthy();
                const stops = (m![1].match(/rgba\(/g) ?? []).length;
                expect(stops).toBe(4);
            }
        });
    });

    describe("aura-wash tokens — primary + neutral, both themes", () => {
        for (const token of ["--btn-aura-primary", "--btn-aura-neutral"]) {
            it(`${token} is defined in the dark theme`, () => {
                expect(DARK).toMatch(new RegExp(`${token}:`));
            });
            it(`${token} is defined in the light theme`, () => {
                expect(LIGHT).toMatch(new RegExp(`${token}:`));
            });
        }
        it("each aura carries three box-shadow stops (inner ring + glow + bloom)", () => {
            for (const block of [DARK, LIGHT]) {
                for (const tok of ["--btn-aura-primary", "--btn-aura-neutral"]) {
                    const m = block.match(new RegExp(`${tok}:\\s*([^;]+);`));
                    expect(m).toBeTruthy();
                    expect((m![1].match(/rgba\(/g) ?? []).length).toBe(3);
                }
            }
        });
    });

    describe("form-control parity edge tokens — both themes", () => {
        for (const token of [
            "--ctrl-edge-rest",
            "--ctrl-edge-hover",
            "--ctrl-edge-focus",
        ]) {
            it(`${token} is defined in the dark theme`, () => {
                expect(DARK).toMatch(new RegExp(`${token}:`));
            });
            it(`${token} is defined in the light theme`, () => {
                expect(LIGHT).toMatch(new RegExp(`${token}:`));
            });
        }
    });

    describe("control-variants.ts scaffold — the parity surface", () => {
        it("exports a `controlEdge` recipe", () => {
            expect(CONTROL_VARIANTS).toMatch(/export\s+const\s+controlEdge\s*=\s*\[/);
        });

        it("exports a `controlSize` map", () => {
            expect(CONTROL_VARIANTS).toMatch(/export\s+const\s+controlSize\s*=/);
        });

        it("exports a `controlVariants` cva", () => {
            expect(CONTROL_VARIANTS).toMatch(/export\s+const\s+controlVariants\s*=\s*cva\(/);
        });

        it("`controlEdge` wires the three R20 control tokens", () => {
            const m = CONTROL_VARIANTS.match(
                /export\s+const\s+controlEdge\s*=\s*\[([\s\S]*?)\];/,
            );
            expect(m).toBeTruthy();
            const body = m![1];
            expect(body).toMatch(/var\(--ctrl-edge-rest\)/);
            expect(body).toMatch(/var\(--ctrl-edge-hover\)/);
            expect(body).toMatch(/var\(--ctrl-edge-focus\)/);
        });

        /*
         * ───────────────────────────────────────────────────────────
         * SUPERSEDED BY #776 — "`controlSize` heights match the button
         * size scale", the four-rung lockstep table.
         *
         * WHAT IT ASSERTED. One `it` walked a literal table —
         * `{ xs: h-7, sm: h-8, md: h-9, lg: h-10 }` — and required
         * BOTH `control-variants.ts` AND `button-variants.ts` to carry
         * that exact height at that exact size key, via one regex per
         * (size, height) pair. Eight matches, four rungs, two files.
         *
         * WHY IT EXISTED. Filter-toolbar rows pair an
         * `<Input size="md">` beside a `<Button size="md">`. A one-rung
         * disagreement between the two maps made the row jitter, so a
         * GRADED scale had to be graded IDENTICALLY on both sides — and
         * that lock was load-bearing enough that R20-PR-C, R20-PR-F and
         * the button-density-tighter pass each moved padding, gap and
         * tracking while explicitly leaving the heights alone, every one
         * of them citing this ratchet by name as the reason.
         *
         * WHY IT WENT. #776 adopted the sibling product's single-rung
         * ladder: every button size resolves to one 28px rung, and
         * `controlSize` collapsed WITH it — the lockstep is the entire
         * reason that map exists, so it could not stay graded once the
         * button side flattened. There is no four-rung ladder left to
         * walk. Re-pointing the table at the new values would assert
         * `h-7` four times against four identical strings: four
         * assertions that cannot fail independently, and a claim of a
         * "scale" where the design deliberately has none.
         *
         * The graded ladder was a real decision made across four
         * roadmap passes, and its reversal was a real decision too.
         * Neither is inferable from a green suite, which is why this
         * note stays instead of the table.
         *
         * WHAT REPLACES IT. The property that actually survived the
         * collapse — the two maps still agree, and each is internally
         * uniform — asserted below as independent checks.
         * ───────────────────────────────────────────────────────────
         */

        it("`controlSize` collapses to ONE rung — every size key resolves to the same class string", () => {
            // Non-emptiness first: an extractor that silently returned
            // "" for all four would make the uniformity check below
            // vacuously true. The key is folded into the expected
            // string so a failure names WHICH size went missing.
            for (const [i, rung] of CONTROL_RUNGS.entries()) {
                expect(`${LADDER_KEYS[i]}=${rung}`).toMatch(/=\S/);
            }
            expect(new Set(CONTROL_RUNGS).size).toBe(1);
        });

        it("the button size ladder collapses to ONE rung — xs/sm/md/lg are byte-identical", () => {
            for (const [i, rung] of BUTTON_RUNGS.entries()) {
                expect(`${LADDER_KEYS[i]}=${rung}`).toMatch(/=\S/);
            }
            expect(new Set(BUTTON_RUNGS).size).toBe(1);
        });

        it("the control rung and the button rung declare the SAME height, and it is the #776 rung", () => {
            // The surviving half of the old lockstep table. Pinning the
            // literal — not just the equality — is what keeps a silent
            // re-grade of BOTH files in step from sliding through, and
            // it proves the extraction found a height at all rather
            // than comparing "" to "".
            const buttonHeight = heightOf(BUTTON_RUNGS[0]);
            const controlHeight = heightOf(CONTROL_RUNGS[0]);
            expect(buttonHeight).toBe(COLLAPSED_HEIGHT);
            expect(controlHeight).toBe(buttonHeight);
        });

        it("both maps keep all four size keys — #776 collapsed the VALUES, not the API", () => {
            // The `size` prop is deliberately retained so call sites
            // still record intent and a re-grade stays a one-file edit
            // instead of a codemod over every `<Button>` in the app.
            // Without this, deleting `xs` and `lg` outright would leave
            // the two uniformity checks above passing over a smaller
            // set — a collapse and an amputation look identical to a
            // "all values are equal" assertion. So the arity is pinned
            // separately from the values.
            for (const key of LADDER_KEYS) {
                expect(
                    `${key}=${rungFor(BUTTON_VARIANTS, BUTTON_SIZE_BODY, key)}`,
                ).toMatch(/=\S/);
                expect(
                    `${key}=${rungFor(CONTROL_VARIANTS, CONTROL_SIZE_BODY, key)}`,
                ).toMatch(/=\S/);
            }
        });

        it("the zero-consumer caveat is STILL TRUE — when this fails, rewrite it rather than unwiring", () => {
            // What the three parity assertions above are worth, stated
            // as something that can fail. `controlSize` /
            // `controlVariants` / `controlEdge` have NO importers:
            // `<Input>` declares its own inline `size` map in
            // `input.tsx` and never adopted this scaffold. So the two
            // maps agreeing proves the R20 parity SURFACE is intact; it
            // does NOT prove a toolbar row lines up, and today it does
            // not — a `<Button size="md">` is 28px while an
            // `<Input size="md">` is still 36px, and they do share rows
            // (`NewTaskFields`, `LeasePaymentsPanel`,
            // `PrescriptionPanel`). Collapsing `input.tsx`'s own map is
            // a separate decision about typing surfaces, tracked on #776.
            //
            // Wiring `<Input>` to this scaffold is the DESIRED outcome,
            // so a failure here is good news: delete this test and the
            // caveat together in that diff. Never unwire the consumer to
            // make it pass. It exists because a caveat nobody can
            // observe going stale is precisely the rot CLAUDE.md keeps
            // warning about.
            const consumers: string[] = [];
            const walk = (dir: string) => {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        walk(full);
                        continue;
                    }
                    if (!/\.tsx?$/.test(entry.name)) continue;
                    const rel = path.relative(ROOT, full);
                    if (rel.endsWith("src/components/ui/control-variants.ts")) continue;
                    if (
                        /from\s+["'][^"']*control-variants["']/.test(
                            fs.readFileSync(full, "utf8"),
                        )
                    ) {
                        consumers.push(rel);
                    }
                }
            };
            walk(path.join(ROOT, "src"));
            expect(consumers).toEqual([]);
        });
    });

    describe("the R19 carbon system is undisturbed", () => {
        // R20-PR-A is FOUNDATION ONLY. It must not touch the R19
        // surface recipes (those evolve in PR-B/D) — every assertion
        // here is a "still there" check, not a "behaves the same"
        // check. The R19 ratchets stay as the substantive lock; this
        // is just the foundation boundary.
        it("--btn-carbon-overlay still exists", () => {
            expect(TOKENS).toMatch(/--btn-carbon-overlay:/);
        });
        it("--btn-glass-inner still exists", () => {
            expect(TOKENS).toMatch(/--btn-glass-inner:/);
        });
        it("--btn-glass-edge still exists", () => {
            expect(TOKENS).toMatch(/--btn-glass-edge:/);
        });
        it("--btn-carbon-grain still exists", () => {
            expect(TOKENS).toMatch(/--btn-carbon-grain:/);
        });
        it("button-variants.ts still exports glassSurface + glassOnHover + carbonStates", () => {
            expect(BUTTON_VARIANTS).toMatch(/const\s+glassSurface\s*=\s*\[/);
            expect(BUTTON_VARIANTS).toMatch(/const\s+glassOnHover\s*=\s*\[/);
            expect(BUTTON_VARIANTS).toMatch(/const\s+carbonStates\s*=\s*\[/);
        });
    });
});
