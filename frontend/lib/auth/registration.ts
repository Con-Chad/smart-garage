/**
 * Self-registration gate (S-3 in the 2026-10-22 audit, D-043).
 *
 * `/register` is closed unless `REGISTRATION_ENABLED` is truthy — except
 * while the user table is empty, so a fresh install can still create its
 * first (admin) account without touching the environment. Admins add further
 * household accounts under User management (`createUserByAdmin`).
 */
export function registrationEnabledByEnv(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.REGISTRATION_ENABLED ?? "").trim());
}

/** Pure decision, so it can be unit-tested without a database. */
export function registrationOpenFor(userCount: number, env?: Record<string, string | undefined>): boolean {
  return userCount === 0 || registrationEnabledByEnv(env);
}
