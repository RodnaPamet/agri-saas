/**
 * Shared detector: which URL-shaped payload fields pin their scheme.
 *
 * Extracted from `tests/guards/promotions-drift.test.ts` (#652) once a second
 * guard needed it (#667). Two guards importing the same parser is the point —
 * a detector that silently stopped detecting would otherwise fail open in both
 * places independently.
 *
 * It PARSES rather than greps, which is load-bearing now that several of these
 * schemas carry docblocks that quote `z.string().url()` while explaining why
 * the field no longer uses it. A regex would flag the prose.
 */
import * as ts from 'typescript';

export interface UrlFieldScan {
    /** Every URL-shaped property name found, in source order. */
    fields: string[];
    /** `path:line — name …` for each field that accepts any scheme. */
    unpinned: string[];
    /** `path:name` for every field found — the key shape an allowlist uses. */
    keys: string[];
}

/**
 * Every URL-shaped property in a schema source, and whether it is
 * scheme-constrained.
 *
 * A property counts as URL-shaped if its name ends in `Url`/`url`, or its
 * initializer mentions `.url(`. It counts as pinned if that initializer routes
 * through an `httpsUrl()` helper or spells `z.url({ protocol: … })` inline.
 */
export function findUnpinnedUrlFields(
    displayPath: string,
    source: string,
): UrlFieldScan {
    const sf = ts.createSourceFile(displayPath, source, ts.ScriptTarget.Latest, true);
    const fields: string[] = [];
    const unpinned: string[] = [];
    const keys: string[] = [];

    const visit = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && node.name && ts.isIdentifier(node.name)) {
            const name = node.name.text;
            const init = node.initializer.getText(sf);
            const looksUrl = /url$/i.test(name) || init.includes('.url(');
            if (looksUrl) {
                fields.push(name);
                keys.push(`${displayPath}:${name}`);
                const pinned = init.includes('httpsUrl(') || /z\.url\(\s*\{/.test(init);
                if (!pinned) {
                    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
                    unpinned.push(`${displayPath}:${line} — ${name} accepts any URL scheme`);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return { fields, unpinned, keys };
}
