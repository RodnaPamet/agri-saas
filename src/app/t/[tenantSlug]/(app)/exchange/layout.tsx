/**
 * Exchange route-group shell.
 *
 * The module gate deliberately does NOT live here any more. It used to, and a
 * group-wide `requireModule` is what made the module-opt-out defect
 * unrecoverable: a tenant that switched EXCHANGE off was bounced away from
 * `/exchange/my-listings` too, so it could not reach the one page that lists
 * the offers it needed to withdraw — offers that, until this PR, stayed public
 * the whole time.
 *
 * The gate now sits on the PARTICIPATION pages (`/exchange` browse and
 * `/exchange/my-interests`), while the CUSTODY page (`/exchange/my-listings`)
 * stays reachable. Same split as the API: see `exchange/my-listings/route.ts`
 * and the WITHDRAW exemption in `exchange/listings/[listingId]/route.ts`.
 */
export default function ExchangeGroupLayout({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
}
