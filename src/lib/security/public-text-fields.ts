/**
 * Fields whose value may reach an UNAUTHENTICATED reader. P1.7.
 *
 * ## What an entry is a CLAIM about
 *
 * That the value is safe in the hands of a stranger — someone with no session,
 * holding at most a URL. Not "it is not secret", and not "it is plaintext in
 * the database": those are different properties, and conflating them is the
 * mistake this file exists to prevent.
 *
 * ## Why this is NOT `DELIBERATELY_PLAINTEXT`
 *
 * `DELIBERATELY_PLAINTEXT` in `encrypted-fields.ts` claims "this field holds
 * nothing warranting encryption AT REST, and the database holds no ciphertext
 * for it". That is a storage decision. This file is an EXPOSURE decision, and
 * the two are orthogonal:
 *
 *   - plaintext at rest AND tenant-private — `ExchangeListing.commodity` is
 *     stored in the clear and must still only reach the parties to a listing.
 *     It belongs in that file and NOT in this one.
 *   - public AND encrypted at rest — nothing today, but nothing prevents it: a
 *     field can be encrypted for storage and still be rendered to a stranger
 *     after decryption. An entry here would be correct and would say nothing
 *     about the column's bytes.
 *
 * So neither set contains the other, and a field's presence in one is no
 * evidence about the other. Owner ruling, 2026-10-02, when the two were at
 * risk of being built as one registry under two names.
 *
 * ## How the population was derived
 *
 * Not from imagination. Of the 16 public API prefixes in
 * `PUBLIC_PATH_PREFIXES`, the genuinely unauthenticated DATA reads are the two
 * invite previews — `/api/invites/[token]` and `/api/org/invite/[token]`.
 * Everything else is a probe, is credential-gated at the handler
 * (`/api/admin/*`, `/api/scim/`), serves the session owner their own data
 * (`/api/auth`), or 403s in production (`/api/staging/seed`). The same two the
 * P1.6 public read tier covers, arrived at independently.
 *
 * ## What is deliberately ABSENT, and why that matters as much
 *
 * `TenantInvite.email` and `OrgInvite.email` are NOT here, and the routes do
 * not return them. They answer `matchesSession` — a boolean — instead, so the
 * response cannot confirm WHO was invited to a caller who merely holds the
 * link. An absent entry is a claim too.
 */

/** `Model.field` → why a stranger may see it. */
export const PUBLIC_TEXT_FIELDS: Readonly<Record<string, string>> = {
    'Tenant.name':
        'Shown on the invite landing page so the invitee can tell which farm ' +
        'invited them. A farm name is the one thing an invite MUST disclose to ' +
        'be actionable — an invitation from an unnamed party is not one you can ' +
        'accept. Reaches only a holder of an unexpired, unrevoked token.',
    'Tenant.slug':
        'The URL segment the invitee is sent to after accepting. Already in the ' +
        'link they were given, so withholding it here would hide nothing.',
    'Organization.name':
        'The org-layer counterpart of Tenant.name, on the same landing page and ' +
        'for the same reason.',
    'Organization.slug':
        'The org-layer counterpart of Tenant.slug; likewise already in the link.',
    'TenantInvite.role':
        'The role being offered. Part of what the invitee is agreeing to, so ' +
        'showing it is informed consent rather than disclosure.',
    'TenantInvite.expiresAt':
        'Lets the invitee see they are in time, and makes an expiry explicable ' +
        'rather than a bare 410.',
    'OrgInvite.role':
        'The org-layer counterpart of TenantInvite.role — the org role being ' +
        'offered, shown so acceptance is informed rather than blind.',
    'OrgInvite.expiresAt':
        'The org-layer counterpart of TenantInvite.expiresAt — lets the invitee ' +
        'see they are in time, and makes an expiry explicable rather than a 410.',
};

/**
 * The response key each public route returns → what it discloses.
 *
 * This is the half with teeth. The registry above says which COLUMNS may be
 * public; this says what each public ROUTE actually serialises, so adding a
 * field to one of those responses fails the guard until somebody records what
 * it exposes. `'derived'` marks a value computed rather than read — it
 * discloses no column.
 */
export const PUBLIC_RESPONSE_FIELDS: Readonly<
    Record<string, Readonly<Record<string, string>>>
> = {
    'src/app/api/invites/[token]/route.ts': {
        tenantName: 'Tenant.name',
        tenantSlug: 'Tenant.slug',
        role: 'TenantInvite.role',
        expiresAt: 'TenantInvite.expiresAt',
        // Deliberately a boolean rather than the invited address: it answers
        // "is this invite for you" without confirming WHO was invited to a
        // caller who merely holds the link.
        matchesSession: 'derived',
    },
    'src/app/api/org/invite/[token]/route.ts': {
        organizationName: 'Organization.name',
        organizationSlug: 'Organization.slug',
        role: 'OrgInvite.role',
        expiresAt: 'OrgInvite.expiresAt',
        matchesSession: 'derived',
    },
};
