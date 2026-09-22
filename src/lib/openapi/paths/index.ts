/**
 * Every path-spec module, in one place.
 *
 * `buildOpenApiDoc` calls this after the component walk, so schemas are
 * registered before any operation references them. Adding a domain means
 * adding one line here and one module beside it — and the completeness guard
 * (`tests/guards/openapi-paths-complete.test.ts`) fails for any route file on
 * disk that no module documents AND no baseline entry covers, so a new route
 * cannot go quietly undescribed.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerSecuritySchemes } from './helpers';
import { registerJournalPaths } from './journal.paths';
import { registerFarmTaskPaths } from './farm-tasks.paths';
import { registerFieldOperationPaths } from './field-operations.paths';
import { registerLocationPaths } from './locations.paths';
import { registerGrainPaths } from './grain.paths';
import { registerTaskPaths } from './tasks.paths';

export function registerAllPaths(registry: OpenAPIRegistry): void {
    registerSecuritySchemes(registry);
    registerJournalPaths(registry);
    // The operator path, in the order a field client meets it: the queue,
    // the job it opens from the queue, and the places the job hangs off.
    registerFarmTaskPaths(registry);
    registerFieldOperationPaths(registry);
    registerLocationPaths(registry);
    registerGrainPaths(registry);
    registerTaskPaths(registry);
}
