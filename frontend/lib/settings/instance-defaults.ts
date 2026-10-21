import { DEFAULT_SETTINGS, type UserSettings } from "@/lib/settings/types";
import {
  sanitizeCurrency,
  sanitizeDistanceUnit,
  sanitizeLocale,
  sanitizeVolumeUnit,
} from "@/lib/settings/sanitize";

/**
 * Instance-wide defaults for *new* accounts, set by the operator through env:
 *
 *   DEFAULT_LOCALE=en  DEFAULT_TIMEZONE=America/Chicago  DEFAULT_CURRENCY=USD
 *   DEFAULT_DISTANCE_UNIT=mi  DEFAULT_VOLUME_UNIT=gal
 *
 * Unset or invalid values are ignored, so an install without these variables
 * behaves exactly as before. Existing accounts are never changed — each user
 * can still pick their own units under Settings → Regional. Storage is always
 * metric; these only choose what is displayed.
 */
export type InstancePreferenceOverrides = Partial<
  Pick<UserSettings, "locale" | "timezone" | "currency" | "distanceUnit" | "volumeUnit">
>;

type Env = Record<string, string | undefined>;

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function pick<T extends string>(
  raw: string | undefined,
  sanitize: (value: unknown) => T,
): T | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  // Sanitizers fall back to a default for unknown input; only accept values
  // that survive unchanged.
  return sanitize(value) === value ? (value as T) : undefined;
}

export function getInstancePreferenceOverrides(
  env: Env = process.env,
): InstancePreferenceOverrides {
  const overrides: InstancePreferenceOverrides = {};

  const locale = pick(env.DEFAULT_LOCALE, sanitizeLocale);
  if (locale) overrides.locale = locale;

  const timezone = env.DEFAULT_TIMEZONE?.trim();
  if (timezone && isValidTimezone(timezone)) overrides.timezone = timezone;

  const currency = pick(env.DEFAULT_CURRENCY, sanitizeCurrency);
  if (currency) overrides.currency = currency;

  const distanceUnit = pick(env.DEFAULT_DISTANCE_UNIT, sanitizeDistanceUnit);
  if (distanceUnit) overrides.distanceUnit = distanceUnit;

  const volumeUnit = pick(env.DEFAULT_VOLUME_UNIT, sanitizeVolumeUnit);
  if (volumeUnit) overrides.volumeUnit = volumeUnit;

  return overrides;
}

/** `create` data for a new user's `UserPreferences` row. */
export function newUserPreferencesData(env: Env = process.env) {
  return getInstancePreferenceOverrides(env);
}

/** `create` data for a new user's `UserNotificationSettings` row. */
export function newUserNotificationSettingsData(env: Env = process.env) {
  const { timezone } = getInstancePreferenceOverrides(env);
  return timezone ? { timezone } : {};
}

/** Settings to assume for a user who has no preferences row yet. */
export function defaultSettingsForInstance(env: Env = process.env): UserSettings {
  return { ...DEFAULT_SETTINGS, ...getInstancePreferenceOverrides(env) };
}
