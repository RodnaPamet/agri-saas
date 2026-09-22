/**
 * Every nested relation that can carry PII must be decryptable.
 *
 * `RELATION_KEY_TO_MODEL` in `src/lib/security/pii-middleware.ts` is an
 * ALLOWLIST of Prisma relation keys. `decryptNested` walks a result tree and
 * decrypts a nested object only when its key appears there — generic walking
 * is deliberately not done, because inspecting every relation on every read is
 * a real perf cost for a small ergonomic gain.
 *
 * An allowlist of relation keys has exactly one failure mode, and it points
 * the wrong way: **a key nobody added returns CIPHERTEXT to the caller.** It
 * is silent, because a missing entry is indistinguishable from a relation that
 * carries no PII, and nothing downstream can tell a name from an envelope.
 *
 * That is not hypothetical. `assignee` was mapped and `createdBy` was not, so
 * the task LIST decrypted the assignee's name while the task DETAIL rendered
 * `v1:FTDt/A1v/…` on screen under "Създадена от" — 54 characters of base64
 * where a colleague's name belongs, on a live tenant, found by the native
 * client on 2026-09-22. Twelve User relations had accumulated unmapped; three
 * MAPPED keys did not exist in the schema at all; and `identityLink` was
 * spelled singular where the field is `identityLinks`, so it had never matched
 * anything.
 *
 * The defence until now was one sentence of instruction in a docblock. This
 * derives the answer from the schema instead, in BOTH directions — a missing
 * key fails, and so does a dead one, because a map full of keys that match
 * nothing is how the real gaps stayed invisible.
 */
import { parseSchemaModels } from '../helpers/prisma-schema-models';
import { RELATION_KEY_TO_MODEL, PII_MANAGED_MODELS } from '@/lib/security/pii-middleware';

/**
 * Every relation key in the schema that points at a managed model, mapped to
 * the model(s) it points at.
 *
 * Keyed by FIELD NAME because that is what `decryptNested` sees in a result
 * object — it has no access to Prisma's type information at runtime, only the
 * key. That is also why a key pointing at two different models would be
 * unresolvable, and why the test below refuses one.
 */
function relationKeysPointingAtManagedModels(): Map<string, Set<string>> {
    const managed = new Set(PII_MANAGED_MODELS);
    const found = new Map<string, Set<string>>();
    for (const model of parseSchemaModels()) {
        for (const field of model.fields) {
            if (!managed.has(field.type)) continue;
            const targets = found.get(field.name) ?? new Set<string>();
            targets.add(field.type);
            found.set(field.name, targets);
        }
    }
    return found;
}

describe('PII nested-relation decryption covers every relation that can carry it', () => {
    const required = relationKeysPointingAtManagedModels();

    it('the derivation actually reads the schema (positive control)', () => {
        // An empty derivation satisfies every "for each" assertion below, so
        // without this the guard would pass loudest exactly when the parser
        // broke. `assignee` and `user` are the two keys whose decryption is
        // demonstrably working in production, so their absence here means the
        // instrument is wrong, not the code.
        expect(PII_MANAGED_MODELS.length).toBeGreaterThanOrEqual(4);
        expect(required.size).toBeGreaterThanOrEqual(10);
        expect(required.has('assignee')).toBe(true);
        expect(required.has('user')).toBe(true);
    });

    it('no relation key points at two different managed models', () => {
        // `decryptNested` resolves a key to ONE manifest entry, so an
        // ambiguous key could not be handled correctly whichever way it was
        // mapped. If this ever fails, the map needs to become model-aware
        // rather than key-aware — it is a design change, not a new row.
        const ambiguous = [...required.entries()]
            .filter(([, models]) => models.size > 1)
            .map(([key, models]) => `${key} -> ${[...models].join(', ')}`);
        expect(ambiguous).toEqual([]);
    });

    it('every relation key that can carry PII is mapped, to the right model', () => {
        const missing: string[] = [];
        const wrong: string[] = [];
        for (const [key, models] of required) {
            const target = [...models][0];
            const mapped = RELATION_KEY_TO_MODEL[key];
            if (!mapped) missing.push(`${key} (-> ${target})`);
            else if (mapped !== target) wrong.push(`${key}: mapped ${mapped}, schema says ${target}`);
        }
        if (missing.length || wrong.length) {
            throw new Error(
                `RELATION_KEY_TO_MODEL is out of step with the Prisma schema.\n\n` +
                    (missing.length ? `MISSING (these return CIPHERTEXT to callers):\n  ${missing.join('\n  ')}\n\n` : '') +
                    (wrong.length ? `WRONG MODEL:\n  ${wrong.join('\n  ')}\n\n` : '') +
                    `Add each to RELATION_KEY_TO_MODEL in src/lib/security/pii-middleware.ts. ` +
                    `A nested relation whose key is absent is never decrypted, and the ` +
                    `envelope is rendered verbatim — that is how "Създадена от v1:FTDt/…" ` +
                    `reached an operator's screen.`,
            );
        }
        expect(missing).toEqual([]);
        expect(wrong).toEqual([]);
    });

    it('no mapped key is dead — every one exists in the schema', () => {
        // The other direction, and the one that hid the gaps: `inviter`,
        // `invitedByUser` and `creator` were all mapped and none of the three
        // is a field in this schema. A map that looks populated is why nobody
        // asked whether it was complete.
        const dead = Object.keys(RELATION_KEY_TO_MODEL).filter((k) => !required.has(k));
        expect(dead).toEqual([]);
    });
});
