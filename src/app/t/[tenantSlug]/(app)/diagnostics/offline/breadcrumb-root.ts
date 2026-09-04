/**
 * Where the diagnostics page's breadcrumb root should point, per persona.
 *
 * #812 opened this page to the MECHANISATOR. That immediately made the
 * existing breadcrumb wrong for them: it links to `/t/<slug>/dashboard`, and
 * `isOperatorAllowedPath` does not allow the dashboard — the middleware
 * redirects an operator straight back to `/my-work`. So the first element on
 * a page they can now reach would have been a link that bounces.
 *
 * That matters more here than on an ordinary page. This page carries a
 * breadcrumb *because* it has no nav entry — the trail is the only way back
 * out (see the comment at its call site). A dead trail on a page with no
 * other exit strands the operator on the one screen we just opened to them.
 *
 * A pure function in its own module rather than a ternary inside a 300-line
 * client component, so the persona logic is testable without rendering
 * anything. `breadcrumb-root` is not a reserved App Router filename, so a
 * plain `.ts` sibling is safe here.
 */
import type { Role } from '@prisma/client';

export interface BreadcrumbRoot {
    href: string;
    /**
     * True when the root is the operator's My-work screen rather than the
     * dashboard. The caller uses this to pick the LABEL — it reuses the
     * already-translated `myWork.title` in both locales, so this fix adds no
     * new strings.
     */
    isOperator: boolean;
}

export function diagnosticsBreadcrumbRoot(role: Role, tenantSlug: string): BreadcrumbRoot {
    if (role === 'MECHANISATOR') {
        return { href: `/t/${tenantSlug}/my-work`, isOperator: true };
    }
    return { href: `/t/${tenantSlug}/dashboard`, isOperator: false };
}
