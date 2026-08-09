/**
 * Shared OpenAPI registry.
 *
 * Single registry instance that schema modules can register their
 * components on. The spec generator (`scripts/generate-openapi.ts`,
 * GAP-10 step 3) loads this module last, by which point every
 * schema file imported transitively has run its `.openapi(...)`
 * registrations.
 *
 * Two registration patterns:
 *
 *   1. Inline component registration via `.openapi('Name', ...)` on
 *      the schema definition. The `name` becomes the OpenAPI
 *      component ID. Use this for every request/response schema we
 *      want named in the published spec.
 *
 *   2. `registry.register(name, schema)` for cases where the schema
 *      isn't a top-level export but should still appear as a named
 *      component (rare — most cases want pattern 1).
 *
 * Naming convention (deterministic, domain-prefixed, PascalCase):
 *
 *   <Domain><Variant>             — e.g. PracticeListItem, RiskDetail,
 *                                   EvidenceListItem
 *   <Domain>CreateRequest         — request body for POST
 *   <Domain>UpdateRequest         — request body for PATCH/PUT
 *   <Domain>SetXRequest           — focused mutation request bodies
 *
 *   Cross-cutting types use a flat name:
 *     PaginatedResponse, ErrorResponse, IsoDate, …
 *
 * Component IDs MUST be globally unique across the spec. The unit
 * test in `tests/unit/openapi-foundation.test.ts` asserts uniqueness
 * + presence on every schema this module knows about.
 */
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

export const registry = new OpenAPIRegistry();
