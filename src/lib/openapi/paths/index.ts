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
import { registerGoogleCalendarPaths } from './google-calendar.paths';
import { registerOrthoPaths } from './ortho.paths';
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
import { registerAuthPublicPaths } from './auth-public.paths';
import { registerPublicRegistryPaths } from './public-registry.paths';
import { registerNotificationPaths } from './notifications.paths';
import { registerPlanningPaths } from './planning.paths';
import { registerInventoryPaths } from './inventory.paths';
import { registerAgroPaths } from './agro.paths';
import { registerLeasePaths } from './leases.paths';
import { registerCadastreAndReportPaths } from './cadastre-reports.paths';
import { registerFarmProfilePaths } from './farm-profile.paths';
import { registerMeFarmsPaths } from './me-farms.paths';
import { registerMeNewsPreferencesPaths } from './me-news-preferences.paths';
import { registerMeStreamPaths } from './me-stream.paths';
import { registerTrustSafetyPaths } from './trust-safety.paths';
import { registerAccessReviewPaths } from './access-review.paths';
import { registerModerationPaths } from './moderation.paths';
import { registerAdminMembersPaths } from './admin-members.paths';
import { registerPppRegisterPaths } from './ppp-register.paths';
import { registerFarmBrandPaths } from './farm-brand.paths';
import { registerPublicFarmsPaths } from './public-farms.paths';
import { registerPublicMediaPaths } from './public-media.paths';
import { registerDocumentPaths } from './documents.paths';

export function registerAllPaths(registry: OpenAPIRegistry): void {
    registerSecuritySchemes(registry);
    registerJournalPaths(registry);
    // The operator path, in the order a field client meets it: the queue,
    // the job it opens from the queue, and the places the job hangs off.
    registerFarmTaskPaths(registry);
    registerFieldOperationPaths(registry);
    registerLocationPaths(registry);
    registerGoogleCalendarPaths(registry);
    registerOrthoPaths(registry);
    registerGrainPaths(registry);
    registerTaskPaths(registry);
    // Not tenant-scoped: the per-user preferences a client reads at launch.
    registerAccountPaths(registry);
    registerAccessReviewPaths(registry);
    // The Farm Risk screen the native client is porting.
    registerFarmRiskPaths(registry);
    registerParcelHistoryPaths(registry);
    registerDashboardPaths(registry);
    registerExchangeMessagingPaths(registry);
    registerTrendsPaths(registry);
    registerExchangeListingPaths(registry);
    registerCatalogPaths(registry);
    registerAuthNativePaths(registry);
    // What a client reads BEFORE it holds a credential, as opposed to the
    // handshake above that obtains one.
    registerAuthPublicPaths(registry);
    registerPublicRegistryPaths(registry);
    registerNotificationPaths(registry);
    registerPlanningPaths(registry);
    registerInventoryPaths(registry);
    registerAgroPaths(registry);
    registerLeasePaths(registry);
    registerCadastreAndReportPaths(registry);
    registerFarmProfilePaths(registry);
    registerMeFarmsPaths(registry);
    registerMeNewsPreferencesPaths(registry);
    registerMeStreamPaths(registry);
    registerTrustSafetyPaths(registry);
    registerModerationPaths(registry);
    registerAdminMembersPaths(registry);
    registerPppRegisterPaths(registry);
    registerFarmBrandPaths(registry);
    registerPublicFarmsPaths(registry);
    registerPublicMediaPaths(registry);
    // «Документи» (#2495). APPENDED rather than filed beside the farm
    // profile, and the reason is measured rather than stylistic.
    //
    // `components.schemas` is emitted SORTED, so a module's position cannot
    // move it. `paths` is emitted in REGISTRATION order, so inserting
    // mid-list pushes every later path entry down: 3,880 changed lines in
    // `src/generated/openapi.json` from the middle versus 3,538 from here.
    //
    // Both numbers are mostly a git artifact, not churn — a structured
    // comparison of the two specs shows 3 paths and 6 schemas ADDED, none
    // removed, and every shared schema identical in content. Git's LCS
    // simply aligns repetitive pretty-printed JSON badly. But that file is
    // one ~1 MB document two PRs touching different endpoints already
    // conflict on (see `npm run merge:main`), so the 342 lines are worth
    // not spending.
    registerDocumentPaths(registry);
}
