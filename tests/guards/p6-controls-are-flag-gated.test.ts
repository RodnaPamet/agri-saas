/**
 * A P6 CONTROL in a non-social form is gated too — P6.7 (#1929).
 *
 * ## The hole this covers, named by the bug that found it
 *
 * `social-routes-are-flag-gated` and `social-routes-flag-gated` check ROUTES.
 * `publishAsFarm` is offered by `CreateOfferModal`, which lives on the
 * exchange — not a social surface, and its route is correctly not in either
 * guard's population. So a P6 control sat in front of every web user for as
 * long as nobody looked, while `social.public-profile` was off by default.
 *
 * It could not do anything either: publishing needs the flag for the caller,
 * and `/f/{handle}` checks it globally, so a ticked switch attributed nothing
 * and the link its consent text promises («…с връзка към страницата му…»)
 * could not open. A control that silently does nothing is worse than an absent
 * one — and this one asks for CONSENT to something that will not happen.
 *
 * ## What this guard ranges over, and what it does NOT
 *
 * The population is every `.tsx` under `src/` that mentions a P6 ATTRIBUTION
 * FIELD. That is mechanically derivable; "every P6 control" is not. The labels
 * on this switch live in the `exchange.offer` i18n namespace rather than a
 * social one, so a namespace rule would have found nothing — which is exactly
 * why the original defect was invisible.
 *
 * So the claim is narrow and deliberately stated as such: ONE field, and the
 * guard fires when a SECOND component starts sending it. That is the realistic
 * next instance — somebody adds a quick-offer form, copies the switch, and
 * copies it without the gate.
 *
 * It does not claim to find a P6 control that writes some other field. If one
 * arrives, add it to `P6_ATTRIBUTION_FIELDS` — the test prints the denominator
 * so a reader can see how much is covered rather than inferring it from a tick.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles } from '../helpers/collect-files';

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Fields whose SERVER side only honours them behind `social.public-profile`.
 *
 * `publishAsFarm` attributes an exchange listing to the farm's public page.
 * The server is deliberately lenient about it — it is saved whether or not the
 * page is published yet, so the order of two unrelated decisions never matters
 * — and that leniency is what makes the UI the only place the gate can live.
 */
const P6_ATTRIBUTION_FIELDS = ['publishAsFarm'] as const;

/**
 * What counts as a gate. Either the resolved prop this codebase threads, or
 * the flag key itself for a component that reads it some other way.
 *
 * Deliberately not "any `if`": a component could gate on something unrelated
 * and pass. Naming the flag, or the prop that carries it, is the narrowest
 * thing that means what this guard claims.
 */
const GATE = /\bpublicProfileEnabled\b|'social\.public-profile'/;

function rel(abs: string): string {
    return abs.slice(REPO_ROOT.length + 1);
}

/** Every UI file that mentions a P6 attribution field. */
function uiFilesWithP6Fields(): Array<{ file: string; fields: string[] }> {
    const out: Array<{ file: string; fields: string[] }> = [];
    for (const abs of collectSourceFiles({ roots: ['src'], extensions: ['.tsx'] })) {
        // Comments blanked, so a file that merely DISCUSSES the field — this
        // one's prose, a docblock explaining the gate — is not counted.
        const code = blankNonCode(readFileSync(abs, 'utf8'));
        const fields = P6_ATTRIBUTION_FIELDS.filter((f) =>
            new RegExp(`\\b${f}\\b`).test(code),
        );
        if (fields.length > 0) out.push({ file: rel(abs), fields });
    }
    return out.sort((a, b) => a.file.localeCompare(b.file));
}

describe('a P6 control in a non-social form is flag-gated (#1929)', () => {
    const population = uiFilesWithP6Fields();

    it('ranges over a real population — the denominator', () => {
        // A renamed field would empty this and make the rule below pass over
        // nothing. The printed list is the coverage claim: one field, and
        // however many components currently carry it.
        // eslint-disable-next-line no-console -- the denominator belongs in CI output
        console.log(
            `[p6-controls] fields=${P6_ATTRIBUTION_FIELDS.length} `
                + `components=${population.length}\n  `
                + population.map((p) => `${p.file} → ${p.fields.join(', ')}`).join('\n  '),
        );
        expect(population.length).toBeGreaterThanOrEqual(1);
        expect(population.map((p) => p.file)).toContain(
            'src/app/t/[tenantSlug]/(app)/exchange/CreateOfferModal.tsx',
        );
    });

    it.each(population)('$file gates its P6 control', ({ file, fields }) => {
        const code = blankNonCode(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
        // One assertion carrying the file and the field, so the failure names
        // the component and what it is missing rather than printing `false`.
        expect({
            file,
            fields: fields.join(', '),
            gated: GATE.test(code),
        }).toEqual({ file, fields: fields.join(', '), gated: true });
    });
});
