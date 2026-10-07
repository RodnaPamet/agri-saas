import { notFound } from 'next/navigation';

import { auth } from '@/auth';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { FarmWizard } from './FarmWizard';

/**
 * `/start` — the six-step front door (P3.8).
 *
 * ── it crosses an auth boundary half way through, and that is the design ──
 *
 * Steps 1–2 are registration and run UNAUTHENTICATED: `register/start` creates
 * an unverified user and `register/verify` proves the address. Steps 3–6 create
 * the farm through `POST /api/me/farms`, which is authenticated — the caller
 * has no farm yet, but it does need to be somebody.
 *
 * So the wizard signs in between step 2 and step 3, with the credentials the
 * person just supplied. That is not a shortcut around the login screen: the
 * email has been proven by a code at that point, which is strictly more than
 * a login establishes.
 *
 * An already-signed-in visitor skips straight to step 3. A person may hold
 * SEVERAL farms (owner ruling, relayed on P3.6), so "add another farm" is this
 * same flow minus the registration half — not a separate screen.
 *
 * ── the flag gate is here, not only on the API ──
 *
 * `POST /api/me/farms` calls `assertFeatureEnabled('social.farm-registration')`
 * and throws 404 when it is off. A flag that does not exist is off.
 *
 * Gating only the API would let somebody walk four steps and hit a 404 that
 * reads as a broken link. So the page refuses too, and refuses the same way —
 * `notFound()`, not a "coming soon" screen. The reasoning is the API's own:
 * a dark-launched surface should not be discoverable, and 403 or an explanatory
 * page both say "this exists and you cannot have it yet".
 *
 * Resolved with `userId: null` at step 1 because there is no user then. That
 * reads the global flag state, which is the right question: whether the
 * CAPABILITY is launched, not whether this person is in a cohort.
 */
export const dynamic = 'force-dynamic';

export default async function StartPage() {
    // The global flag state. A visitor at step 1 has no session, so a
    // cohort-scoped answer would be meaningless here.
    if (!(await isFeatureEnabled('social.farm-registration', null))) {
        notFound();
    }

    const session = await auth();
    const signedIn = Boolean(session?.user?.id);

    return (
        <FarmWizard
            // A signed-in visitor is adding a farm, not registering: the first
            // two steps have nothing left to ask them.
            startAtFarmType={signedIn}
        />
    );
}
