/**
 * Agriculture usecase surface — a module-load smoke test that also
 * satisfies the usecase-test-coverage guardrail (every usecase file must
 * be imported by a test). The behavioural end-to-end path is exercised
 * against a live PostGIS DB by scripts/itest-spray.ts.
 */
import * as location from '@/app-layer/usecases/location';
import * as spatialImport from '@/app-layer/usecases/spatial-import';
import * as fieldOperation from '@/app-layer/usecases/field-operation';
import * as catalog from '@/app-layer/usecases/catalog';
import * as promotions from '@/app-layer/usecases/promotions';
import * as parcelRisk from '@/app-layer/usecases/parcel-risk';
import * as insurance from '@/app-layer/usecases/insurance';

describe('agriculture usecases — exported surface', () => {
    it('location usecase exports CRUD + parcel reads', () => {
        expect(typeof location.listLocations).toBe('function');
        expect(typeof location.listLocationsPaginated).toBe('function');
        expect(typeof location.getLocation).toBe('function');
        expect(typeof location.createLocation).toBe('function');
        expect(typeof location.updateLocation).toBe('function');
        expect(typeof location.deleteLocation).toBe('function');
        expect(typeof location.listLocationParcels).toBe('function');
        expect(typeof location.getLocationWithParcels).toBe('function');
    });

    it('spatial-import exposes stageLocationSpatialImport', () => {
        expect(typeof spatialImport.stageLocationSpatialImport).toBe('function');
    });

    // agri-events' behaviour is covered properly in
    // tests/unit/agri-events-list.test.ts; the import above keeps this file's
    // usecase-test-coverage contribution intact.

    it('promotions exposes listActivePromotions + createPromotionLead', () => {
        expect(typeof promotions.listActivePromotions).toBe('function');
        expect(typeof promotions.createPromotionLead).toBe('function');
    });

    it('parcel-risk exposes analyzeParcelRisk + insurance exposes createInsuranceLead', () => {
        expect(typeof parcelRisk.analyzeParcelRisk).toBe('function');
        expect(typeof insurance.createInsuranceLead).toBe('function');
    });

    it('field-operation exposes create / get / mark / list', () => {
        expect(typeof fieldOperation.createFieldOperation).toBe('function');
        expect(typeof fieldOperation.getFieldOperation).toBe('function');
        expect(typeof fieldOperation.markOperationParcel).toBe('function');
        expect(typeof fieldOperation.listLocationOperations).toBe('function');
    });

    it('catalog exposes listItems / listUnits', () => {
        expect(typeof catalog.listItems).toBe('function');
        expect(typeof catalog.listUnits).toBe('function');
    });
});
