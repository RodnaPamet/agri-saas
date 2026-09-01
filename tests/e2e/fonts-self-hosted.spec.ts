/**
 * Web fonts are self-hosted, load, and actually render (#779).
 *
 * READ-ONLY spec — navigates the unauthenticated `/login` page and asserts.
 * No tenant, no fixtures.
 *
 * ## Why this spec exists rather than trusting the hermeticity allowlist
 *
 * `map-basemap-hermetic.spec.ts` asserts the ABSENCE of third-party requests.
 * Absence is satisfied by a page that never loaded a font at all — and by a
 * page where every `@font-face` 404s. Removing `fonts.googleapis.com` from
 * that allowlist therefore proves the fonts are not fetched from Google; it
 * proves nothing about whether they are fetched from us. This spec is the
 * positive half.
 *
 * ## Three measured facts that shape every assertion here
 *
 * 1. **`document.fonts.load()` REJECTS on a 404** — `NetworkError: A network
 *    error occurred.` It does NOT resolve with `status: 'error'`. So a loop
 *    over `fontFaceSet` checking `.status` is dead code, and a `catch {}`
 *    around the load swallows the only real signal. The check below awaits and
 *    lets the rejection surface.
 *
 * 2. **`document.fonts.load(spec, text)` matches only faces whose
 *    `unicode-range` covers `text`.** Measured: Inter with the cyrillic face
 *    present → 1 match; the same family with it removed → 0. That makes it a
 *    direct PER-SUBSET probe, which is what catches "the latin file shipped
 *    but the cyrillic one did not" — the failure mode that matters most on a
 *    Bulgarian product.
 *
 * 3. **A missing family falls back to the browser DEFAULT (serif), not
 *    `sans-serif`.** So an assertion of the form
 *    `expect(width).not.toBeCloseTo(sansSerifWidth)` PASSES on a broken font.
 *    The width check below compares the app's OWN stack against that same
 *    stack minus its first family, which is the only comparison where the two
 *    sides differ by exactly the thing under test.
 *
 * ## The bystander that made an earlier version of this spec pass falsely
 *
 * With a mixed-script probe like `"Обработка на нивата"`, dropping Inter's
 * cyrillic face still measured 169.5 vs 167.81 — different, so the check
 * "passed". The reason is that **U+0020 sits in the LATIN `unicode-range`**,
 * so the spaces kept rendering from the surviving latin face and moved the
 * total width on their own. The space was a bystander satisfying the check.
 * Probes here are therefore SINGLE-SCRIPT and SPACE-FREE by construction.
 */
import { test, expect } from '@playwright/test';
import { safeGoto } from './e2e-utils';

/** Families the app declares, and a probe string inside each one's script. */
const PROBES = [
    // Space-free, single-script. See the bystander note above.
    { family: 'Inter', script: 'latin', text: 'Handgloves' },
    { family: 'Inter', script: 'cyrillic', text: 'Обработка' },
    { family: 'Onest', script: 'latin', text: 'Handgloves' },
    { family: 'Onest', script: 'cyrillic', text: 'Обработка' },
    // Bricolage is digits-only by product convention (no Cyrillic face exists
    // upstream), so it is probed on digits alone.
    { family: 'Bricolage Grotesque', script: 'latin', text: '1234567890' },
] as const;

test.describe('self-hosted web fonts', () => {
    test.describe.configure({ retries: 0 });

    test('every declared face loads, per script, from our own origin', async ({ page }) => {
        const external: string[] = [];
        page.on('request', (req) => {
            let host: string;
            try {
                host = new URL(req.url()).hostname;
            } catch {
                return;
            }
            if (!host || host === 'localhost' || host === '127.0.0.1') return;
            external.push(`${req.method()} ${req.url()}`);
        });

        // Font responses are collected from the NETWORK, which survives a
        // navigation. `page.evaluate` does not: /login is client-rendered and
        // something re-navigates shortly after the form appears (production
        // `next start` runs the chunk-error auto-reload and the SW registrar),
        // which destroys the execution context mid-probe. That cost two CI
        // runs — the lesson is that a spec asserting on a settled page has to
        // choose primitives that tolerate the page NOT being settled.
        const fontResponses: { url: string; status: number }[] = [];
        page.on('response', (res) => {
            const u = res.url();
            if (u.includes('/fonts/') && u.endsWith('.woff2')) {
                fontResponses.push({ url: u, status: res.status() });
            }
        });

        await safeGoto(page, '/login', { timeout: 90_000 });
        await expect(
            page.locator('#credentials-form input[type="email"][name="email"]'),
        ).toBeVisible({ timeout: 60_000 });

        // ── 1. Each (family, script) pair resolves to at least one face ────
        // `waitForFunction` RE-EVALUATES after a navigation instead of
        // rejecting, so it is the navigation-tolerant form of the probe.
        // `load()` still rejects on a 404 — that rejection is captured per
        // probe rather than swallowed. The returned array length is the
        // per-subset signal: 0 means no face covers this script.
        const handle = await page.waitForFunction(
            async (probes) => {
                const out: { family: string; script: string; matched: number; error: string | null }[] = [];
                for (const p of probes) {
                    try {
                        const faces = await document.fonts.load(`600 16px "${p.family}"`, p.text);
                        out.push({ family: p.family, script: p.script, matched: faces.length, error: null });
                    } catch (err) {
                        out.push({
                            family: p.family,
                            script: p.script,
                            matched: -1,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                }
                return out;
            },
            PROBES as unknown as { family: string; script: string; text: string }[],
            { timeout: 60_000 },
        );
        const results = (await handle.jsonValue()) as {
            family: string;
            script: string;
            matched: number;
            error: string | null;
        }[];

        for (const r of results) {
            expect(
                r.error,
                `${r.family}/${r.script}: document.fonts.load rejected — a face 404'd`,
            ).toBeNull();
            expect(
                r.matched,
                `${r.family}/${r.script}: no @font-face covers this script (unicode-range gap or missing file)`,
            ).toBeGreaterThan(0);
        }

        // ── 1b. Every font the page actually requested came from us, and OK ─
        // Independent of the probe above and immune to navigation: this is the
        // 404 detector that cannot be raced.
        expect(fontResponses.length, 'the page requested no self-hosted font at all').toBeGreaterThan(0);
        const bad = fontResponses.filter((r) => r.status !== 200);
        expect(bad, `self-hosted fonts returned non-200: ${JSON.stringify(bad)}`).toEqual([]);

        // ── 2. The app's OWN stack renders in the vendored family ──────────
        // Measured against the stack MINUS its first family, because a missing
        // family falls back to the browser default (serif) — so comparing to
        // `sans-serif` would pass on a broken font.
        const widthsHandle = await page.waitForFunction((text) => {
            const stack = getComputedStyle(document.body).fontFamily;
            const families = stack.split(',').map((s) => s.trim());
            const measure = (fontFamily: string) => {
                const el = document.createElement('span');
                el.textContent = text;
                el.style.cssText =
                    'position:absolute;visibility:hidden;white-space:pre;font-size:64px;font-weight:600;';
                el.style.fontFamily = fontFamily;
                document.body.appendChild(el);
                const w = el.getBoundingClientRect().width;
                el.remove();
                return w;
            };
            return {
                stack,
                withFirst: measure(stack),
                withoutFirst: measure(families.slice(1).join(', ')),
                familyCount: families.length,
            };
        }, 'Handgloves', { timeout: 60_000 });
        const widths = (await widthsHandle.jsonValue()) as {
            stack: string;
            withFirst: number;
            withoutFirst: number;
            familyCount: number;
        };

        expect(widths.familyCount, `body font stack has no fallback to compare against: ${widths.stack}`)
            .toBeGreaterThan(1);
        expect(
            widths.withFirst,
            `body renders identically with and without its first family (${widths.stack}) — ` +
                `the vendored face is not being applied`,
        ).not.toBeCloseTo(widths.withoutFirst, 1);

        // ── 3. Nothing left the origin ─────────────────────────────────────
        expect(external, 'a self-hosted font page must reach no third party').toEqual([]);
    });
});
