/**
 * Practice usecase barrel export.
 *
 * All public functions are re-exported here so existing imports
 * from '@/app-layer/usecases/practice' continue to work unchanged.
 */
export {
    listPractices,
    listPracticesPaginated,
    getPractice,
    getPracticeHeader,
    getPracticeActivity,
    getPracticeDashboard,
    runConsistencyCheck,
    listPracticesWithDeleted,
} from './queries';

export {
    createPractice,
    updatePractice,
    setPracticeStatus,
    setPracticeApplicability,
    setPracticeOwner,
    markPracticeTestCompleted,
    deletePractice,
    bulkDeletePractice,
    restorePractice,
    purgePractice,
} from './mutations';

export {
    listPracticeTasks,
    createPracticeTask,
    updatePracticeTask,
    deletePracticeTask,
} from './tasks';

export {
    listEvidenceLinks,
    getPracticeEvidenceTab,
    linkEvidence,
    unlinkEvidence,
    linkAssetToPractice,
    unlinkAssetFromPractice,
} from './evidence';

// Page-data orchestration (collapses practice + sync waterfall on detail page)
export { getPracticePageData, type PracticePageDataPayload, type SyncStatusPayload } from './page-data';

// Requirement ↔ practice mapping (survivor of the removed template library)
export {
    listFrameworkRequirements,
    mapRequirementToPractice,
    unmapRequirementFromPractice,
    listPracticeMappings,
} from './requirements';
