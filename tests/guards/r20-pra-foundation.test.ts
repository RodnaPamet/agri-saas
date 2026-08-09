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

        it("`controlSize` heights match the button size scale", () => {
            // Filter-toolbar rows pair Inputs and Buttons side by
            // side. If a button is `h-9` at size=md, an input must
            // be `h-9` at size=md too — otherwise the row jitters.
            // The R20-PR-A ratchet locks the four sizes in lockstep.
            const expected: Record<string, string> = {
                xs: "h-7",
                sm: "h-8",
                md: "h-9",
                lg: "h-10",
            };
            for (const [size, height] of Object.entries(expected)) {
                // controlSize.<size> must contain the height.
                const ctrlRe = new RegExp(
                    `${size}:\\s*["'][^"']*${height}\\b[^"']*["']`,
                );
                expect(CONTROL_VARIANTS).toMatch(ctrlRe);
                // And button-variants.ts must carry the same height
                // at the same size key.
                expect(BUTTON_VARIANTS).toMatch(ctrlRe);
            }
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
