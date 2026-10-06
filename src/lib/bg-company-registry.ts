/**
 * Търговски регистър lookup — the name shown as a user types their ЕИК (P3.7).
 *
 * ── the privacy constraint that shapes this whole file ──
 *
 * ADR 0002 OD21 asks for the CC0 dump so registration can show the registered
 * name. OD2's stated consequence is the reason this is not a simple key-value
 * lookup:
 *
 * > since 2022 more than 300,000 self-insured farmers hold a 9-digit БУЛСТАТ —
 * > so **ЕИК can itself be personal data**. "Use ЕИК, never ЕГН" is therefore
 * > not a clean split between corporate and personal identifiers, and the
 * > public-field allowlist is what keeps it lawful rather than the choice of
 * > identifier alone.
 *
 * A public, unauthenticated endpoint that turns an ЕИК into a NAME is, for
 * those 300,000-plus, a public endpoint that turns personal data into a natural
 * person's name — and one that can be walked, since the ЕИК keyspace is small
 * and checksum-validated.
 *
 * So the rule here is the one this repo already adopted for cadastre
 * ownership (`src/lib/cadastre/privacy.ts`, where individual owners are masked
 * and only legal entities are usable): **a name is returned only for a LEGAL
 * ENTITY. A natural person or sole trader resolves to `null`.**
 *
 * That is not a limitation to be relaxed later for convenience. It is the thing
 * that makes the endpoint publishable at all.
 *
 * ── why there is no data source wired yet ──
 *
 * Deliberately unwired rather than guessed at. Importing the dump is its own
 * piece of work with decisions this file cannot make for the owner: which
 * distribution, how often it refreshes, where it is stored, and — the one that
 * matters here — how a legal entity is distinguished from a sole trader in
 * that data, because the whole privacy argument above rests on getting that
 * classification right.
 *
 * Until then `lookupRegisteredName` resolves to `null`, which is a legitimate
 * answer the endpoint already has to handle: an ЕИК can be structurally valid
 * and absent from the register, and the caller must not treat "no name" as
 * "invalid".
 */

/** What a registry provider must return. `null` name = do not display one. */
export interface RegistryEntry {
    /** Legal-entity name, or `null` for a natural person / sole trader. */
    name: string | null;
}

/**
 * A source of registry entries. Nothing implements this yet — see the docblock.
 *
 * An implementation MUST return `{ name: null }` for a natural person rather
 * than their name, and MUST NOT distinguish "absent from the register" from
 * "present but a natural person" in what it returns, since the caller surfaces
 * both as "no name" and the difference would itself be informative.
 */
export interface RegistryProvider {
    lookup(eik: string): Promise<RegistryEntry | null>;
}

let provider: RegistryProvider | null = null;

/** Wire a provider. Intended for the import job (P3.7's second half) and tests. */
export function setRegistryProvider(p: RegistryProvider | null): void {
    provider = p;
}

/**
 * The registered name for an ЕИК, or `null`.
 *
 * `null` covers three cases on purpose and does not distinguish them: no
 * provider configured, not in the register, and present but a natural person.
 * A caller that could tell those apart would have an oracle over exactly the
 * population the privacy rule exists to protect.
 */
export async function lookupRegisteredName(eik: string): Promise<string | null> {
    if (!provider) return null;
    const entry = await provider.lookup(eik);
    return entry?.name ?? null;
}
