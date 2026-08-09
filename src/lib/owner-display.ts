/**
 * Owner / assignee display name for entity tables (Asset / Risk / Practice /
 * Task). Shows the person's NAME, never their full email address. When no name
 * is set yet, falls back to the email's local-part (the "username" before `@`)
 * so name-less OAuth accounts still read as a handle rather than a raw address.
 *
 * UI roadmap item 14: "remove email from the Owner column — leave the username /
 * Name only." (Capturing real first/last names — so a name is always present —
 * is the separate follow-up.)
 */
export function ownerDisplayName(
    name?: string | null,
    email?: string | null,
): string | null {
    const trimmedName = name?.trim();
    if (trimmedName) return trimmedName;
    const local = email?.split('@')[0]?.trim();
    return local && local.length > 0 ? local : null;
}
