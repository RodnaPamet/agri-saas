/**
 * Links the assistant offers — built by the SERVER from what it read, never
 * emitted by the model — #2578.
 *
 * ## Why this diverges from the plan on the issue
 *
 * #2578's design was for `links` to be a structured field the model emits,
 * "validated by provenance — the id must have appeared in a tool result this
 * turn, which RLS already scoped". That is sound and this is stronger, by the
 * same reasoning the answer choke point uses: prefer the guarantee that holds
 * by CONSTRUCTION over the one that holds because something checks it.
 *
 * A link assembled here cannot name a record the turn did not read, because
 * the only material it is built from IS the tool results. There is no
 * fabricated id to catch, so there is no validator to get wrong, and no
 * question about what happens on a validation miss — the failure mode is
 * absent rather than handled.
 *
 * It also sidesteps a dependency I could not confirm: `completeWithRouting`
 * never names `schema`, so model-emitted structured output would have rested
 * on a pass-through I had not measured.
 *
 * ## The cost, stated
 *
 * The model no longer chooses WHICH records to link, so relevance is lost:
 * the server offers links to what it read, newest first, capped. A model that
 * answered about one overdue task may still be shown links to all five it
 * saw. That is a worse ranking and a better guarantee, and the ranking can be
 * improved later without weakening anything — asking the model to REORDER a
 * server-built list is safe in a way asking it to author one is not.
 *
 * ## Tenant-RELATIVE and concrete
 *
 * `/farm-tasks/abc123`, never `/t/acme/farm-tasks/abc123` and never the
 * bracketed template. A prefix-less link cannot express a cross-tenant
 * destination at all, so the invariant is structural rather than validated —
 * agreed with the iOS client, which strips a leading `/t/<farm>` if one ever
 * arrives so a foreign id fails closed under RLS.
 */
import { PAGE_ROUTE_TEMPLATE_SET } from '@/lib/assistant/generated/page-routes';

/** At most this many links on one answer. */
export const MAX_LINKS = 5;
/** A label longer than this is truncated rather than dropped. */
export const MAX_LABEL_CHARS = 80;

export interface AssistantLink {
    /** Concrete and tenant-relative, e.g. `/farm-tasks/abc123`. */
    readonly route: string;
    readonly label: string;
}

/**
 * What a tool declares so its rows can become links.
 *
 * `template` is the TENANT-SCOPED page template with its record parameter
 * intact — `/farm-tasks/[taskId]`. It is checked against the generated set at
 * build time below, with the `/t/[tenantSlug]` prefix restored, so a tool
 * cannot declare a link to a screen this app does not serve.
 */
export interface LinkShape {
    readonly template: string;
    readonly idField: string;
    readonly labelField: string;
}

/** `/farm-tasks/[taskId]` → `/t/[tenantSlug]/farm-tasks/[taskId]`. */
function fullTemplate(template: string): string {
    return `/t/[tenantSlug]${template}`;
}

/**
 * True when the tool's declared template names a real screen.
 *
 * Exported because the tool guard asserts it for every declared shape: a tool
 * whose template is not a screen produces links that 404, and the failure
 * would surface on a phone rather than in CI.
 */
export function linkTemplateIsReal(template: string): boolean {
    return PAGE_ROUTE_TEMPLATE_SET.has(fullTemplate(template));
}

/** The single bracketed record parameter, or null when the shape is wrong. */
function recordParam(template: string): string | null {
    const found = [...template.matchAll(/\[([^\]]+)\]/g)].map((m) => m[0]);
    return found.length === 1 ? found[0] : null;
}

/**
 * Build links from one tool's rows.
 *
 * Returns nothing rather than throwing on anything unexpected — a malformed
 * row, a missing id, an unreal template. Links are an affordance, so an absent
 * link costs a tap and a wrong one costs trust.
 */
export function linksFromRows(shape: LinkShape, rows: unknown): AssistantLink[] {
    if (!Array.isArray(rows)) return [];
    if (!linkTemplateIsReal(shape.template)) return [];
    const param = recordParam(shape.template);
    if (param === null) return [];

    const out: AssistantLink[] = [];
    for (const row of rows) {
        if (typeof row !== 'object' || row === null) continue;
        const r = row as Record<string, unknown>;
        const id = r[shape.idField];
        const label = r[shape.labelField];
        // An id must be an id: the same bounded charset the page context's
        // `selectedIds` uses, so a value from a tool result cannot carry a
        // path segment or a query string into a route.
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
        if (typeof label !== 'string' || label.trim() === '') continue;
        out.push({
            route: shape.template.replace(param, id),
            label: label.trim().slice(0, MAX_LABEL_CHARS),
        });
    }
    return out;
}

/**
 * Merge, de-duplicate and cap.
 *
 * De-duplicated by ROUTE, so two tools returning the same record offer one
 * link. Capped last, so the cap applies to distinct destinations rather than
 * to repeats.
 */
export function mergeLinks(groups: readonly AssistantLink[][]): AssistantLink[] {
    const seen = new Set<string>();
    const out: AssistantLink[] = [];
    for (const group of groups) {
        for (const link of group) {
            if (seen.has(link.route)) continue;
            seen.add(link.route);
            out.push(link);
            if (out.length >= MAX_LINKS) return out;
        }
    }
    return out;
}
