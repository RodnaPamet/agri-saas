/**
 * ONE source of truth for the ContractStatus / ContractType labels.
 *
 * The regression this file locks had already shipped: the five-member
 * enum existed in THREE places —
 *
 *   1. hardcoded English literals in `grain/contracts/filter-defs.ts`
 *      (`CONTRACT_STATUS_LABELS`), which the create/edit modal rendered
 *      verbatim, so a Bulgarian user got translated badges and chips
 *      and then an English dropdown;
 *   2. a flattened `grainEnums.statusDraft…` set used by the filter chip;
 *   3. `ag.status.contract.*`, used by the table badge.
 *
 * Bulgarian had already drifted between (2) and (3): the filter chip
 * said "Уредена / Отказан" while the badge two columns away said
 * "Уреден / Отменен" for the same contract. Nothing could catch that —
 * key-parity between locales is blind to two keys that disagree with
 * each other, and the hardcoded-string ratchet only scanned `.tsx`.
 *
 * Now `ag.status.contract` is the only copy, and these assertions fail
 * if a second one reappears in either catalogue.
 */

import en from '../../messages/en.json';
import bg from '../../messages/bg.json';
import {
    ALL_CONTRACT_STATUSES,
    ALL_CONTRACT_TYPES,
} from '@/app-layer/domain/contract-status';
import {
    contractStatusOptions,
    contractTypeOptions,
} from '@/app/t/[tenantSlug]/(app)/grain/contracts/filter-defs';

type Catalogue = typeof en;

const CATALOGUES: Array<[string, Catalogue]> = [
    ['en', en as Catalogue],
    ['bg', bg as unknown as Catalogue],
];

describe('contract enum labels — single source of truth', () => {
    describe.each(CATALOGUES)('%s.json', (_locale, catalogue) => {
        const agStatus = catalogue.ag.status as Record<string, Record<string, string>>;

        it('covers every ContractStatus member under ag.status.contract', () => {
            for (const member of ALL_CONTRACT_STATUSES) {
                expect(agStatus.contract[member]).toBeTruthy();
            }
            // No extra members: a key for a status the enum dropped is
            // dead copy that a translator will keep maintaining.
            expect(Object.keys(agStatus.contract).sort()).toEqual(
                [...ALL_CONTRACT_STATUSES].sort(),
            );
        });

        it('covers every ContractType member under ag.status.contractType', () => {
            expect(Object.keys(agStatus.contractType).sort()).toEqual(
                [...ALL_CONTRACT_TYPES].sort(),
            );
        });

        it('has NO second copy of the members under grainEnums', () => {
            // The flattened `statusDraft` / `typeSale` shape is what
            // drifted. Its absence is the invariant.
            // `grainEnums` now holds nested groups too (costCategory), so
            // the value type is not uniformly string. Only the KEYS matter
            // here, and `unknown` is the honest widening.
            const grainEnums = catalogue.grainEnums as unknown as Record<string, unknown>;
            const strays = Object.keys(grainEnums).filter((k) =>
                /^(status|type)(Draft|Active|Delivered|Settled|Cancelled|Sale|Purchase)$/.test(k),
            );
            expect(strays).toEqual([]);
        });
    });

    it('en and bg both label every member, and differently', () => {
        const enStatus = (en.ag.status as Record<string, Record<string, string>>).contract;
        const bgStatus = (bg as unknown as typeof en).ag.status.contract as Record<string, string>;

        for (const member of ALL_CONTRACT_STATUSES) {
            expect(bgStatus[member]).toBeTruthy();
            // A Bulgarian value identical to the English one is the
            // "translated by copy-paste" failure the i18n guard hunts.
            expect(bgStatus[member]).not.toBe(enStatus[member]);
        }
    });

    describe('option builders', () => {
        // A translator stub that echoes the key, so the assertions are
        // about WHICH key is requested — the thing that must be shared.
        const echo = (key: string) => key;

        it('resolves statuses through ag.status.contract.<MEMBER>', () => {
            expect(contractStatusOptions(echo)).toEqual([
                { value: 'DRAFT', label: 'status.contract.DRAFT' },
                { value: 'ACTIVE', label: 'status.contract.ACTIVE' },
                { value: 'DELIVERED', label: 'status.contract.DELIVERED' },
                { value: 'SETTLED', label: 'status.contract.SETTLED' },
                { value: 'CANCELLED', label: 'status.contract.CANCELLED' },
            ]);
        });

        it('resolves types through ag.status.contractType.<MEMBER>', () => {
            expect(contractTypeOptions(echo)).toEqual([
                { value: 'SALE', label: 'status.contractType.SALE' },
                { value: 'PURCHASE', label: 'status.contractType.PURCHASE' },
            ]);
        });

        it('derives its member list from the domain enum, not a local copy', () => {
            // Adding a status to the Prisma enum must surface in the
            // dropdown without a second edit.
            expect(contractStatusOptions(echo).map((o) => o.value)).toEqual([
                ...ALL_CONTRACT_STATUSES,
            ]);
            expect(contractTypeOptions(echo).map((o) => o.value)).toEqual([
                ...ALL_CONTRACT_TYPES,
            ]);
        });
    });
});
