/** Re-exports for the bearer/cookie parity test (kept out of the spec so jest
 *  does not treat this file as a suite). */
export { checkTenantAccess } from '@/lib/auth/guard';
export { MAX_JWT_MEMBERSHIPS as MAX_JWT_MEMBERSHIPS_PROBE } from '@/auth';
