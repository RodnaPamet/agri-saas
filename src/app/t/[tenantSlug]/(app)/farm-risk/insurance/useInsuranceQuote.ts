'use client';

/**
 * The calculator's whole state, in one reducer.
 *
 * Every figure the farmer sees is DERIVED here and recomputed on each
 * keystroke — there is no Calculate button and no stored premium. The only
 * stored values are what the farmer typed or picked, so the quote can never
 * disagree with the inputs shown beside it.
 *
 * The premium the SERVER returns is the one that counts; this is the preview
 * that makes the server's answer predictable.
 */
import { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import { haToDca, trimNumber } from '@/lib/agro/rate-calc';
import {
    getProduct,
    parseAreaDca,
    parseMoneyToCents,
    productForCrop,
    quotePremium,
    sumInsuredFromPerDca,
    type InstalmentCount,
    type InsuranceProductKey,
    type QuoteResult,
} from '@/lib/insurance';

export type ProductKind = 'crop' | 'peril';
export type SumMode = 'total' | 'perDca';

export interface QuoteState {
    kind: ProductKind;
    productKey: InsuranceProductKey | null;
    areaRaw: string;
    sumRaw: string;
    sumMode: SumMode;
    instalments: InstalmentCount;
    note: string;
}

type Action =
    | { type: 'kind'; kind: ProductKind }
    | { type: 'product'; productKey: InsuranceProductKey }
    | { type: 'area'; raw: string }
    | { type: 'sum'; raw: string }
    | { type: 'sumMode'; mode: SumMode }
    | { type: 'instalments'; n: InstalmentCount }
    | { type: 'note'; note: string };

function reducer(state: QuoteState, action: Action): QuoteState {
    switch (action.type) {
        case 'kind':
            if (action.kind === state.kind) return state;
            // Switching Crop <-> Weather risk clears the product: the previous
            // pick belongs to the other group, and silently keeping it would
            // leave a selected radio the farmer cannot see.
            return { ...state, kind: action.kind, productKey: null };
        case 'product':
            return { ...state, productKey: action.productKey };
        case 'area':
            return { ...state, areaRaw: action.raw };
        case 'sum':
            return { ...state, sumRaw: action.raw };
        case 'sumMode':
            // The RAW text is kept, not converted. "100 000" means one thing as
            // a total and another per decare; rewriting it under the farmer
            // would change a number they did not touch.
            return action.mode === state.sumMode ? state : { ...state, sumMode: action.mode };
        case 'instalments':
            return { ...state, instalments: action.n };
        case 'note':
            return { ...state, note: action.note };
    }
}

export interface UseInsuranceQuoteArgs {
    /** The crop the parcel card shows, used to preselect a product. */
    cropType?: string | null;
    /** Parcel area in HECTARES, as the rest of Farm risk carries it. */
    areaHa?: number | null;
}

export interface UseInsuranceQuote {
    state: QuoteState;
    /** Parsed area, or null when the field cannot be read as a number. */
    areaDca: number | null;
    /** Parsed sum insured in cents — already converted when in per-dca mode. */
    sumInsuredCents: number | null;
    /** The other form of the sum insured, for the echo under the field. */
    counterpartCents: number | null;
    tariffBp: number | null;
    quote: QuoteResult | null;
    /**
     * Has the farmer changed anything they would mind losing?
     *
     * Compared against the INITIAL state rather than tracking edits, so it
     * cannot drift, and it counts the AREA too — a farmer who corrected the
     * prefilled area and nothing else has still done work, and a silent
     * discard on Escape would throw it away.
     */
    isDirty: boolean;
    setKind: (kind: ProductKind) => void;
    setProduct: (key: InsuranceProductKey) => void;
    setArea: (raw: string) => void;
    setSum: (raw: string) => void;
    setSumMode: (mode: SumMode) => void;
    setInstalments: (n: InstalmentCount) => void;
    setNote: (note: string) => void;
    /**
     * The key to send with the NEXT request.
     *
     * Stable while the four quote inputs are unchanged, so a retry after a
     * failed send replays the same lead rather than creating a second one.
     * Any change to those inputs mints a NEW key — otherwise the retry would
     * return the ORIGINAL lead and the farmer would believe the corrected
     * figures had gone out.
     */
    idempotencyKey: () => string;
}

export function useInsuranceQuote({
    cropType,
    areaHa,
}: UseInsuranceQuoteArgs): UseInsuranceQuote {
    /**
     * The state this calculator STARTED in, held in state rather than a ref.
     *
     * `isDirty` compares against it on every render, and a ref may not be read
     * during render — the React compiler lint says so, and it is right: a ref
     * read in render is invisible to the compiler's memoisation. `useState`'s
     * lazy initialiser runs exactly once, which is the same "capture it on first
     * render" guarantee without the hazard.
     */
    const [initialState] = useState<QuoteState>((): QuoteState => {
        // `productForCrop` returns the KEY, so look the product up for its kind.
        const preselectedKey = productForCrop(cropType) ?? null;
        const preselected = preselectedKey ? getProduct(preselectedKey) : undefined;
        return {
            // An unmapped crop ("Grass") preselects nothing and leaves the
            // group on Crop, so Next stays disabled until the farmer picks.
            kind: preselected?.kind ?? 'crop',
            productKey: preselectedKey,
            areaRaw: areaHa == null ? '' : trimNumber(haToDca(areaHa)),
            sumRaw: '',
            sumMode: 'total',
            instalments: 1,
            note: '',
        };
    });
    const [state, dispatch] = useReducer(reducer, initialState);

    const isDirty =
        state.areaRaw !== initialState.areaRaw ||
        state.sumRaw !== initialState.sumRaw ||
        state.note !== initialState.note ||
        state.productKey !== initialState.productKey ||
        state.instalments !== initialState.instalments ||
        state.sumMode !== initialState.sumMode;

    const areaDca = useMemo(() => parseAreaDca(state.areaRaw), [state.areaRaw]);

    const typedCents = useMemo(() => parseMoneyToCents(state.sumRaw), [state.sumRaw]);

    const sumInsuredCents = useMemo(() => {
        if (typedCents == null) return null;
        if (state.sumMode === 'total') return typedCents;
        if (areaDca == null) return null;
        return sumInsuredFromPerDca(typedCents, areaDca);
    }, [typedCents, state.sumMode, areaDca]);

    const tariffBp = useMemo(() => {
        const product = state.productKey ? getProduct(state.productKey) : undefined;
        return product?.tariffBp ?? null;
    }, [state.productKey]);

    const quote = useMemo(() => {
        if (areaDca == null || sumInsuredCents == null || tariffBp == null) return null;
        return quotePremium({
            areaDca,
            sumInsuredCents,
            tariffBp,
            instalments: state.instalments,
        });
    }, [areaDca, sumInsuredCents, tariffBp, state.instalments]);

    /**
     * The echo under the sum field shows the OTHER form, so a mistyped amount
     * is visible before it is sent. Derived from the quote when there is one
     * (its per-dca figure is already rounded the way the server rounds it).
     */
    const counterpartCents = useMemo(() => {
        if (quote?.ok) {
            return state.sumMode === 'total'
                ? quote.sumInsuredPerDcaCents
                : quote.sumInsuredCents;
        }
        return null;
    }, [quote, state.sumMode]);

    const mintedRef = useRef<{ key: string; signature: string } | null>(null);
    const signature = `${state.productKey ?? ''}|${areaDca ?? ''}|${sumInsuredCents ?? ''}|${state.instalments}`;
    const idempotencyKey = useCallback(() => {
        const current = mintedRef.current;
        if (current && current.signature === signature) return current.key;
        const key = crypto.randomUUID();
        mintedRef.current = { key, signature };
        return key;
    }, [signature]);

    return {
        state,
        isDirty,
        areaDca,
        sumInsuredCents,
        counterpartCents,
        tariffBp,
        quote,
        setKind: useCallback((kind: ProductKind) => dispatch({ type: 'kind', kind }), []),
        setProduct: useCallback(
            (productKey: InsuranceProductKey) => dispatch({ type: 'product', productKey }),
            [],
        ),
        setArea: useCallback((raw: string) => dispatch({ type: 'area', raw }), []),
        setSum: useCallback((raw: string) => dispatch({ type: 'sum', raw }), []),
        setSumMode: useCallback((mode: SumMode) => dispatch({ type: 'sumMode', mode }), []),
        setInstalments: useCallback((n: InstalmentCount) => dispatch({ type: 'instalments', n }), []),
        setNote: useCallback((note: string) => dispatch({ type: 'note', note }), []),
        idempotencyKey,
    };
}
