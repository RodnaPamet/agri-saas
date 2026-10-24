/**
 * Roadmap-4 PR-9 — destructive-action vocabulary.
 *
 * Destructive flows in the product (delete a tenant, revoke an API
 * key, remove MFA, archive evidence) currently use a thoughtful
 * mix of verbs:
 *
 *   • Revoke API key   — invalidate a credential
 *   • Revoke SCIM token— invalidate a credential
 *   • Delete SSO conf  — permanent erasure of a configuration
 *   • Remove MFA       — deactivate (user can re-enroll later)
 *
 * The verbs map cleanly to intent — exactly the pattern Roadmap-2
 * PR-5 established for *constructive* actions (Create / Add /
 * Link). This ratchet locks the same discipline for destructive
 * actions so future PRs can't drift toward "Drop", "Clear",
 * "Cancel", or other verbs that read as ambiguous.
 *
 * Canonical destructive verbs
 *
 *   - **Delete**     — permanent erasure of a top-level entity or
 *                      configuration. The data is gone.
 *   - **Remove**     — detach an item from a parent, OR turn off
 *                      an enrollment. Source row may live on.
 *   - **Revoke**     — invalidate an authority / credential
 *                      (token, key, session, role grant).
 *   - **Discard**    — abandon unsaved or draft state.
 *   - **Archive**    — soft delete with history preserved.
 *   - **Unlink**     — break an association (cross-entity
 *                      traceability link, custom-role binding).
 *   - **Detach**     — like Unlink, used where "link" is also a
 *                      verb in the same surface (file detach,
 *                      vendor document detach).
 *   - **Reject**     — refuse a request (approval, finding).
 *
 * What this ratchet locks
 *
 *   Every `<ConfirmDialog tone="danger">` callsite MUST have a
 *   `confirmLabel="<verb> …"` that begins with one of the
 *   canonical verbs above. The detector pairs the `tone="danger"`
 *   line with the nearest `confirmLabel=` on the same prop block
 *   so we don't false-positive on unrelated label strings
 *   elsewhere in the file.
 *
 * What this ratchet does NOT police
 *
 *   - Destructive `<Button>` labels outside a ConfirmDialog
 *     (inline Reject / Archive on rows). Those are already
 *     governed by the existing action-label vocabulary ratchet
 *     and the Epic 67 undo-toast convention; layering a third
 *     scan would duplicate without clarifying.
 *
 *   - Email / notification copy. Those use the verbs
 *     organically; out of scope.
 *
 *   - Title sentences (e.g. "Revoke API key?"). The verb is
 *     already in the confirmLabel — duplicating the assertion
 *     would catch nothing the confirmLabel check misses.
 */
import * as fs from 'fs';
import * as path from 'path';
import { readCatalogue } from '../helpers/catalogue';
import * as ts from 'typescript';
import { blankNonCode } from '../helpers/blank-non-code';
import { keyInRange, resolveTranslationCalls } from '../helpers/i18n-key-resolver';

const ROOT = path.resolve(__dirname, '../..');

const CANONICAL_VERBS = [
    'Delete',
    'Remove',
    'Revoke',
    'Discard',
    'Archive',
    'Unlink',
    'Detach',
    'Reject',
];

// Match `confirmLabel="<verb> …"` (or `'<verb> …'`). Case-
// sensitive on the verb because the canonical form is title-
// case ("Delete" not "delete").
const VERB_OK = new RegExp(
    `^(${CANONICAL_VERBS.join('|')})\\b`,
);

interface Offence {
    file: string;
    line: number;
    label: string;
}

/**
 * Dialogs whose label the resolver genuinely CANNOT read — not ones it has
 * merely not been taught to.
 *
 * Until #2226 this map held twelve entries, every one a site writing
 * `confirmLabel={t('key')}` with a prose note recording what the key resolves
 * to. The detector could not read a key, so the rule was enforced against the
 * single remaining site that still hardcoded English and the notes stood in
 * for a check on the rest. They were honest notes. They were not checks.
 *
 * The detector resolves keys now, so an entry here has to be something else: a
 * label that is not a single static key at all. `every exemption names a
 * dialog that is REALLY unresolvable` below deletes the excuse the moment the
 * resolver can read it, which is what stops this growing back.
 */
const UNRESOLVABLE_EXEMPT: Record<string, string> = {
    // The shared bulk-delete hook passes `confirmLabel={verb}`, and `verb` is a
    // PROP, so no static label exists to resolve — the caller supplies it. It
    // is exempt because the TYPE enforces the rule the regex would have: the
    // prop is a union of canonical verbs, so a non-canonical one does not
    // compile. `the one remaining exemption is enforced by the COMPILER` below
    // checks that union against CANONICAL_VERBS rather than taking this note's
    // word for it.
    'src/components/ui/table/use-bulk-delete.tsx':
        "confirmLabel={verb}, and `verb` is typed to a union of canonical verbs — the compiler enforces it",
};

/** The file whose `verb` union stands in for this guard's check. */
const COMPILER_ENFORCED_FILE = 'src/components/ui/table/use-bulk-delete.tsx';

/**
 * The label a `confirmLabel=` attribute resolves to, and how it was obtained.
 *
 * `literal` is `confirmLabel="Delete bin"`. `resolved` is
 * `confirmLabel={t('key')}` looked up in the **en** catalogue through the
 * shared scope-chain resolver — which is the whole of #2226: fourteen of
 * fifteen danger-tone dialogs write the second form, and the old
 * literal-only regex could not read any of them, so each sat in
 * `DYNAMIC_LABEL_EXEMPT` behind a prose note. A note is not a check.
 *
 * `unresolvable` is the honest remainder: a dynamic expression that is not a
 * single static key. Those are counted and named, never guessed.
 */
type LabelSource = 'literal' | 'resolved' | 'unresolvable';

interface Graded {
    file: string;
    line: number;
    label: string;
    source: LabelSource;
}

/** Flattened `<namespace>.<key>` → message, from the en catalogue. */
function enMessages(): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (node: unknown, prefix: string): void => {
        if (node === null || typeof node !== 'object') return;
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            const full = prefix ? `${prefix}.${k}` : k;
            if (typeof v === 'string') out.set(full, v);
            else walk(v, full);
        }
    };
    walk(readCatalogue('en'), '');
    return out;
}

function tsxFiles(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name === '.next') continue;
            tsxFiles(full, out);
        } else if (/\.tsx$/.test(e.name)) {
            out.push(full);
        }
    }
    return out;
}

/**
 * Every `tone="danger"` JSX element, with the label it actually shows.
 *
 * ## Why the AST and not a line window
 *
 * This paired the danger marker with the nearest `confirmLabel=` within TWELVE
 * LINES. That bound was wrong in both directions and the second one was live:
 *
 *   · too SMALL — `admin/security/page.tsx`'s revoke dialog puts a three-way
 *     ternary in `title` and another in `description`, so its
 *     `confirmLabel={t('revoke')}` sits 15 lines below the marker. The window
 *     could not see it and the site reported as `<missing confirmLabel>`. It
 *     had never been noticed because that whole FILE was exempt;
 *   · too LARGE — twelve lines is also enough to reach into the NEXT element,
 *     so a dialog with no label could borrow its neighbour's and pass.
 *
 * Reading attributes off the element removes the bound entirely: a
 * `confirmLabel` either belongs to this element or it does not.
 *
 * ## And the exemption is per SITE now, not per FILE
 *
 * The old map was keyed by file and `continue`d the whole file, so any OTHER
 * danger dialog in an exempted file went ungraded too — twelve files' worth.
 * `UNRESOLVABLE_EXEMPT` is still keyed by file, but only an *unresolvable*
 * site in it is excused; a resolvable one in the same file is graded.
 */
function gradeFile(file: string, messages: Map<string, string>): Graded[] {
    const text = fs.readFileSync(file, 'utf-8');
    if (!/tone\s*=\s*["']danger["']/.test(text)) return [];

    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const { calls } = resolveTranslationCalls(file, text);
    const graded: Graded[] = [];

    const attrOf = (el: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | null => {
        for (const a of el.attributes.properties) {
            if (ts.isJsxAttribute(a) && a.name.getText(sf) === name) return a;
        }
        return null;
    };

    const lineOf = (node: ts.Node): number =>
        sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

    const visit = (node: ts.Node): void => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            const tone = attrOf(node, 'tone');
            const toneInit = tone?.initializer;
            const isDanger =
                toneInit !== undefined &&
                toneInit !== null &&
                ts.isStringLiteral(toneInit) &&
                toneInit.text === 'danger';

            if (isDanger) {
                const label = attrOf(node, 'confirmLabel');
                const init = label?.initializer;

                if (init === undefined || init === null) {
                    graded.push({
                        file: rel,
                        line: lineOf(node),
                        label: '<missing confirmLabel>',
                        source: 'literal',
                    });
                } else if (ts.isStringLiteral(init)) {
                    graded.push({ file: rel, line: lineOf(label!), label: init.text, source: 'literal' });
                } else {
                    // `confirmLabel={…}` — resolvable only when the expression
                    // is exactly one static translation call.
                    const found = keyInRange(calls, init.getStart(sf), init.getEnd());
                    const message = found === null ? undefined : messages.get(found.key);
                    graded.push({
                        file: rel,
                        line: lineOf(label!),
                        label:
                            message ??
                            (found === null
                                ? init.getText(sf).replace(/\s+/g, ' ')
                                : `<key not in en: ${found.key}>`),
                        source: message === undefined ? 'unresolvable' : 'resolved',
                    });
                }
            }
        }
        ts.forEachChild(node, visit);
    };

    visit(sf);
    return graded;
}

describe('Destructive-action vocabulary (Roadmap-4 PR-9, #2226)', () => {
    const messages = enMessages();
    const all = tsxFiles(path.join(ROOT, 'src')).flatMap((f) => gradeFile(f, messages));
    const exemptUnresolvable = all.filter(
        (g) => g.source === 'unresolvable' && UNRESOLVABLE_EXEMPT[g.file] !== undefined,
    );
    const graded = all.filter(
        (g) => g.source !== 'unresolvable' || UNRESOLVABLE_EXEMPT[g.file] === undefined,
    );

    it('control: the catalogue loaded and the resolver found labels', () => {
        // Without this, every assertion below passes for free on a broken
        // resolver or an empty catalogue — the shape this guard was IN until
        // #2226, where it graded 1 site and exempted 14.
        expect(messages.size).toBeGreaterThan(1000);
        expect(all.length).toBeGreaterThan(10);
        // And the point of the change: most labels now come from a KEY, not a
        // literal. If this flips back, the resolver stopped working.
        expect(all.filter((g) => g.source === 'resolved').length).toBeGreaterThan(
            all.filter((g) => g.source === 'literal').length,
        );
    });

    it('control: a SECOND method finds the same files, so the AST walk missed none', () => {
        // Cross-check in a different method, because the failure mode of an AST
        // walk is silence: a JSX form it does not recognise contributes nothing
        // and the denominator shrinks with nothing saying so. That is exactly
        // what the twelve-line window did — it counted a `tone="danger"` inside
        // a COMMENT and reported 12 where there are 11.
        //
        // Compares FILE SETS rather than counts: this method cannot tell two
        // dialogs in one file apart, and claiming it can would be the same
        // over-reach again.
        const byRegex = new Set<string>();
        for (const f of tsxFiles(path.join(ROOT, 'src'))) {
            // `blankNonCode`, not a regex pair: stripping BLOCK comments before
            // LINE ones is the #1442/#1497 defect — a line comment containing
            // a block-open opens a block as far as a regex is concerned and
            // eats every real line to the next close. `comment-stripper-order`
            // caught this control doing exactly that.
            const code = blankNonCode(fs.readFileSync(f, 'utf-8'));
            if (/tone\s*=\s*["']danger["']/.test(code)) {
                byRegex.add(path.relative(ROOT, f).split(path.sep).join('/'));
            }
        }
        const byAst = new Set(all.map((g) => g.file));
        expect(byRegex.size).toBeGreaterThan(5);
        expect([...byRegex].filter((f) => !byAst.has(f)).sort()).toEqual([]);
        expect([...byAst].filter((f) => !byRegex.has(f)).sort()).toEqual([]);
    });

    it('prints its DENOMINATOR, so 1-of-15 cannot read as 15-of-15', () => {
        // #2226 point 4. The old failure message named only offenders, so a
        // reader could not tell how much was being graded at all — which is
        // how fourteen exemptions accumulated without anyone noticing.
        const by = (s: LabelSource) => all.filter((g) => g.source === s).length;
        console.log(
            `[destructive-vocabulary] ${graded.length} danger-tone dialog(s) GRADED ` +
                `(${by('literal')} literal, ${by('resolved')} resolved from an i18n key), ` +
                `${exemptUnresolvable.length} exempt as unresolvable ` +
                `of ${all.length} found.`,
        );
        expect(graded.length + exemptUnresolvable.length).toBe(all.length);
    });

    it('every exemption names a dialog that is REALLY unresolvable', () => {
        // The map may only hold cases the resolver genuinely cannot read. An
        // entry for a site that now resolves is a stale excuse, and this is
        // the direction that let the old map grow to fourteen.
        const stale = Object.keys(UNRESOLVABLE_EXEMPT).filter(
            (f) => !all.some((g) => g.file === f && g.source === 'unresolvable'),
        );
        expect(stale).toEqual([]);
    });

    it('the one remaining exemption is enforced by the COMPILER, not by its note', () => {
        // The exemption claims the `verb` prop's type does this guard's job.
        // That claim is itself checkable, so it is checked: every member of
        // the union must be a canonical verb. Widen the union to something
        // non-canonical and this fails, which is the whole difference between
        // an exemption and the twelve prose notes it replaced.
        const src = fs.readFileSync(path.join(ROOT, COMPILER_ENFORCED_FILE), 'utf-8');
        const decl = src.match(/verb\?:\s*([^;]+);/);
        expect(decl).not.toBeNull();
        const members = (decl as RegExpMatchArray)[1]
            .split('|')
            .map((m) => m.trim().replace(/^["']|["']$/g, ''));
        // A control: the extractor found a real union, not an empty list that
        // satisfies the subset check for free.
        expect(members.length).toBeGreaterThan(1);
        expect(members.filter((m) => !(CANONICAL_VERBS as readonly string[]).includes(m)))
            .toEqual([]);
    });

    it('every graded ConfirmDialog tone="danger" carries a canonical verb', () => {
        const offenders = graded.filter((g) => !VERB_OK.test(g.label));
        if (offenders.length > 0) {
            const lines = offenders
                .map((o) => `  ${o.file}:${o.line} — ${o.source} label "${o.label}"`)
                .join('\n');
            throw new Error(
                `These ConfirmDialog destructive flows use a non-canonical verb. ` +
                    `Use one of: ${CANONICAL_VERBS.join(', ')}.\n${lines}\n\n` +
                    `(${graded.length} graded, ${exemptUnresolvable.length} exempt.)`,
            );
        }
        expect(offenders).toEqual([]);
    });
});
