/**
 * Every path-spec module, in one place.
 *
 * `buildOpenApiDoc` calls this after the component walk, so schemas are
 * registered before any operation references them. Adding a domain means
 * adding one line here and one module beside it — and the completeness guard
 * (`tests/guards/openapi-paths-complete.test.ts`) fails for any route file on
 * disk that no module documents, so a new route cannot go quietly undescribed.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerSecuritySchemes } from './helpers';
import { registerJournalPaths } from './journal.paths';

export function registerAllPaths(registry: OpenAPIRegistry): void {
    registerSecuritySchemes(registry);
    registerJournalPaths(registry);
}
