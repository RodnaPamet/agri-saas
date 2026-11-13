/**
 * Which fields under `src/app-layer` carry a notification DESTINATION, and
 * what prefix posture each one has (#3033).
 *
 * ## Why this is shared rather than spelled twice
 *
 * Two guards range over these fields on different axes:
 *
 *   `notification-link-is-tenant-scoped`  is the destination tenant-PREFIXED
 *   `person-push-link-resolves`           does it name a page that EXISTS
 *
 * Both were written with a local copy of the field list, and the prefix guard's
 * copy had ONE entry — `linkUrl` — so it was correct about everything it ranged
 * over while two real defects rode `link:` straight past it on a single day
 * (#2987, #3032). It derived over the right tree and the wrong KEY.
 *
 * A guard whose population is a hand-written list of field names goes stale the
 * moment a producer picks a different name, and nothing fails. So the list lives
 * here, once, and each guard applies its own rule to it. The EXTRACTORS stay in
 * their own files deliberately: each is a module-level selector that
 * `selector-teeth` mutation-audits, and a file with no such selector is reported
 * NOT AUDITED, which is a population with its own ceiling.
 *
 * ## The postures are not a style choice
 *
 * `tenant-prefixed` — the server owns the shape, so correcting a destination
 * never needs a client release. A push client resolves it absolutely.
 *
 * `farm-relative` — deliberately NOT prefixed, because the destination is
 * person-scoped and the farm is not known where the value is built. #2987
 * RENAMED the field to say so, which is why the posture is readable from the
 * name rather than from a comment. `person-push-link-resolves` owns the
 * inverted assertion (such a value must NOT start with `t`); the prefix guard
 * deliberately does not restate it, because one property in two spellings is
 * the #1664 class both guards exist to avoid.
 *
 * ## `url:` is deliberately absent, and that is a decision
 *
 * The email payloads in `tenant-invites` and `org-invites` write
 * `url: `${base}/invite/${token}`` — a destination, and correctly NOT
 * tenant-prefixed, because `src/app/invite/[token]` lives outside the tenant
 * shell and an invitee has no membership yet. Adding `url` here would report
 * both as violations and the "fix" would break invitation acceptance.
 *
 * It is also the widest name of the four, so including it would pull in every
 * unrelated `url:` in the tree — 46 assignments, measured 2026-11-14, against
 * the 2 that are destinations.
 */
export const DESTINATION_FIELDS = {
    farmRelativePath: 'farm-relative',
    link: 'tenant-prefixed',
    linkUrl: 'tenant-prefixed',
    linkPath: 'tenant-prefixed',
} as const;

export type DestinationField = keyof typeof DESTINATION_FIELDS;
export type DestinationPosture = (typeof DESTINATION_FIELDS)[DestinationField];

/**
 * A `link:` whose value is an OBJECT is a `LinkShape` declaration, not a
 * destination.
 *
 * `src/app-layer/ai/assistant/tools.ts` writes
 * `link: { template: '/farm-tasks/[taskId]', idField: 'id', … }` — three sites,
 * measured. `linksFromRows` expands that template per row into
 * `AssistantLink.route`, which `links.ts` documents as "Concrete and
 * tenant-relative, e.g. `/farm-tasks/abc123`". So the literal here is a
 * TEMPLATE in the generated-route vocabulary (`[taskId]`, not `${id}`), the
 * expansion is tenant-relative by contract, and grading either against the
 * `/t/` rule would report three non-defects — and "fixing" them would break the
 * assistant's links.
 *
 * Structural rather than a file allowlist: the shape IS the discriminator, so a
 * fourth tool declaring a template is covered the moment it exists, and a
 * `link:` that goes back to being a plain path is graded again automatically.
 */
export function isLinkShapeDeclaration(value: string): boolean {
    return value.trimStart().startsWith('{');
}
