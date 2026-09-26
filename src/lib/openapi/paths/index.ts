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
import { registerAccountPaths } from './account.paths';
import { registerFarmRiskPaths } from './farm-risk.paths';
import { registerParcelHistoryPaths } from './parcel-history.paths';
import { registerDashboardPaths } from './dashboard.paths';
import { registerExchangeMessagingPaths } from './exchange-messaging.paths';
import { registerTrendsPaths } from './trends.paths';
import { registerExchangeListingPaths } from './exchange-listings.paths';
import { registerCatalogPaths } from './catalog.paths';
import { registerAuthNativePaths } from './auth-native.paths';
import { registerNotificationPaths } from './notifications.paths';
import { registerPlanningPaths } from './planning.paths';
import { registerInventoryPaths } from './inventory.paths';
import { registerAgroPaths } from './agro.paths';
import { registerLeasePaths } from './leases.paths';
import { registerCadastreAndReportPaths } from './cadastre-reports.paths';

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
    // Not tenant-scoped: the per-user preferences a client reads at launch.
    registerAccountPaths(registry);
    // The Farm Risk screen the native client is porting.
    registerFarmRiskPaths(registry);
    registerParcelHistoryPaths(registry);
    registerDashboardPaths(registry);
    registerExchangeMessagingPaths(registry);
    registerTrendsPaths(registry);
    registerExchangeListingPaths(registry);
    registerCatalogPaths(registry);
    registerAuthNativePaths(registry);
    registerNotificationPaths(registry);
    registerPlanningPaths(registry);
    registerInventoryPaths(registry);
    registerAgroPaths(registry);
    registerLeasePaths(registry);
    registerCadastreAndReportPaths(registry);
}
