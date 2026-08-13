/**
 * Action-button canonical-entity label ratchet (2026-05-28).
 *
 * The product's header action buttons now follow ONE convention:
 *
 *     <Button variant="primary" icon={<Plus />}>{Entity}</Button>
 *
 * — i.e. the visible label is JUST the entity noun (`Asset`,
 * `Risk`, `Practice`, `Task`, `Vendor`, …). The `+` glyph rides the
 * `icon` slot so the Button primitive centres the icon + label as
 * one tidy unit (`[+][Asset]` centred together — see button.tsx;
 * the old icon-balance ghost was reverted 2026-05-31). A button
 * labelled `Create Asset` + Plus-icon reads visually as
 * "+ Create Asset" — the verb is dead weight once the glyph is
 * doing the work.
 *
 * Previous convention (R22-PR-G era) used verb-prefix labels
 * (`Create Asset` / `New Audit` / `Add Evidence`). 2026-05-28
 * reversed that: drop the verb, keep just the noun.
 *
 * This ratchet enforces two invariants:
 *
 *   1. The header-action i18n keys (`addX`, `newX` — by
 *      convention, the keys consumed by header trigger buttons)
 *      do NOT carry a verb prefix in their value.
 *   2. The canonical entity pages render their header action button
 *      via the `icon={<Plus />}` slot — not via an inline `+ Entity`
 *      literal — so the `+` and the noun centre together as one tidy
 *      unit. The registry named seven pages before GRC teardown phase 2
 *      (Practices, Risks, Policies, Vendors and Tasks went with the
 *      inherited surface); Assets and Evidence are what remain.
 *
 * Companion: `action-label-vocabulary.test.ts` (the older
 * R22-PR-G ratchet) bans literal `"+ Word"` text in JSX/source.
 * Together: this file bans verb-prefixed text values, the older
 * file bans `+ ` literal prefixes — both arrows point at the
 * same canonical visual: icon-slot Plus + bare noun label.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

describe('Action-button canonical entity label', () => {
    describe('1. i18n header-action keys carry no verb prefix', () => {
        const en = () => JSON.parse(read('messages/en.json')) as Record<string, unknown>;

        // Map of {namespace: header-action key}. These keys are
        // referenced by entity-page header Buttons (the `+ Entity`
        // affordance opens a create modal). Other contexts
        // (`createX` for modal submit buttons, dashboard "Quick
        // Actions", form titles) keep their verbed forms — they
        // belong to confirmation surfaces, not action triggers.
        // GRC teardown phase 2 removed the `audits.newAudit` and
        // `findings.newFinding` rows — neither page exists to render a
        // header button, so the keys are no longer header-action keys.
        const HEADER_ACTION_KEYS: Array<[string, string, string]> = [
            ['assets', 'addAsset', 'Asset'],
            // "Record", not "Evidence": the page, its nav entry, its title,
            // its counts and this button now all say the same word, in the
            // register a farmer uses. It previously said "Records" in the
            // sidebar and "Evidence" on the button — and in Bulgarian,
            // "Документи" in the sidebar and "Библиотека с доказателства" on
            // the page, which is two different names for one place.
            ['evidence', 'addEvidence', 'Record'],
        ];

        it.each(HEADER_ACTION_KEYS)(
            '%s.%s = "%s" (just the noun — no verb prefix)',
            (ns, key, expected) => {
                const block = (en()[ns] ?? {}) as Record<string, unknown>;
                expect(block[key]).toBe(expected);
            },
        );

        it('no header-action value starts with `Create `, `Add `, `New `, or `Edit `', () => {
            // Negative scan — defensive against a future PR
            // reintroducing a verbed label under one of the
            // header-action keys.
            const FORBIDDEN = /^(Create|Add|New|Edit) /;
            for (const [ns, key] of HEADER_ACTION_KEYS) {
                const block = (en()[ns] ?? {}) as Record<string, unknown>;
                const value = block[key];
                expect(typeof value).toBe('string');
                expect(value as string).not.toMatch(FORBIDDEN);
            }
        });
    });

    describe('2. Header action buttons use the icon-slot Plus pattern', () => {
        // Inline-literal callers — Plus is imported, Button has
        // both `icon={<Plus />}` AND a bare entity-noun label.
        // [file, buttonId, expected bare-noun label, i18n namespace the
        //  button's t()/tr() call resolves against]
        //
        // GRC teardown phase 2 emptied this registry — every site it held
        // was a GRC entity page. Repopulated with the two surviving
        // canonical entity pages, which resolve their label through a
        // pre-resolved translations object (`{t.addAsset}`) rather than a
        // `t('key')` call; the matcher below accepts both forms.
        const INLINE_SITES: Array<[string, string, string, string]> = [
            ['src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx', 'new-asset-btn', 'Asset', 'assets'],
            ['src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx', 'add-evidence-btn', 'Record', 'evidence'],
        ];

        it.each(INLINE_SITES)(
            '%s uses icon={<Plus />} + bare label `%s`',
            (file, btnId, label, ns) => {
                const src = read(file);
                const idIdx = src.indexOf(`id="${btnId}"`);
                expect(idIdx).toBeGreaterThan(-1);
                const buttonStart = src.lastIndexOf('<Button', idIdx);
                const buttonEnd = src.indexOf('</Button>', idIdx);
                expect(buttonStart).toBeGreaterThan(-1);
                expect(buttonEnd).toBeGreaterThan(buttonStart);
                const buttonBlock = src.slice(buttonStart, buttonEnd);
                // 1. Plus icon is wired into the icon slot so the `+`
                //    and the noun read as one tidy `+Noun` unit. (The
                //    Plus carries a small negative margin — `-mr-…` —
                //    so it concatenates flush to the label per the
                //    2026-05-31 "+Asset" directive.)
                expect(buttonBlock).toMatch(/icon=\{<Plus(\s+className="[^"]*")?\s*\/>\}/);
                // 2. The label appears as JSX text content. We find
                //    the closing `>` of the opening <Button …> tag
                //    (NOT the self-closing `/>` from <Plus />) and
                //    check the text between it and </Button>.
                const lastGT = buttonBlock.lastIndexOf('>');
                expect(lastGT).toBeGreaterThan(-1);
                const textContent = buttonBlock.slice(lastGT + 1).trim();
                // i18n batches T07/T09 — migrated labels route through
                // next-intl (`{t('list.addPractice')}`, `{tr('newButton')}`).
                // Accept either the bare literal noun OR a `<binding>('<key>')`
                // call whose en.json value (under the site's namespace)
                // resolves to the same bare noun. Binding may be t/tr/etc.
                // Two i18n shapes reach the same place:
                //   `{t('list.addPractice')}` — a next-intl call, and
                //   `{t.addAsset}`            — a property read off a
                //                               pre-resolved messages object.
                // Both resolve to a key under the site's namespace.
                const tCall =
                    textContent.match(/^\{\w+\(['"]([a-zA-Z0-9_.]+)['"]\)\}$/) ??
                    textContent.match(/^\{\w+\.([a-zA-Z0-9_.]+)\}$/);
                if (tCall) {
                    const en = JSON.parse(read('messages/en.json')) as Record<string, unknown>;
                    // `ns` may itself be dotted (e.g. 'tasks.list' when the
                    // component calls useTranslations('tasks.list')); walk it
                    // segment-by-segment, then walk the t() key.
                    let resolved: unknown = en;
                    for (const part of `${ns}.${tCall[1]}`.split('.')) {
                        resolved = (resolved as Record<string, unknown> | undefined)?.[part];
                    }
                    expect(resolved).toBe(label);
                } else {
                    expect(textContent).toBe(label);
                }
            },
        );
    });
});
