import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./types";
import {
  defaultSettingsForInstance,
  getInstancePreferenceOverrides,
  newUserNotificationSettingsData,
  newUserPreferencesData,
} from "./instance-defaults";

const US = {
  DEFAULT_LOCALE: "en",
  DEFAULT_TIMEZONE: "America/Chicago",
  DEFAULT_CURRENCY: "USD",
  DEFAULT_DISTANCE_UNIT: "mi",
  DEFAULT_VOLUME_UNIT: "gal",
};

describe("instance preference defaults", () => {
  it("changes nothing when no env is set", () => {
    expect(getInstancePreferenceOverrides({})).toEqual({});
    expect(newUserPreferencesData({})).toEqual({});
    expect(newUserNotificationSettingsData({})).toEqual({});
    expect(defaultSettingsForInstance({})).toEqual(DEFAULT_SETTINGS);
  });

  it("applies a full US configuration", () => {
    expect(newUserPreferencesData(US)).toEqual({
      locale: "en",
      timezone: "America/Chicago",
      currency: "USD",
      distanceUnit: "mi",
      volumeUnit: "gal",
    });
    expect(newUserNotificationSettingsData(US)).toEqual({ timezone: "America/Chicago" });
    expect(defaultSettingsForInstance(US)).toMatchObject({ distanceUnit: "mi", volumeUnit: "gal" });
  });

  it("ignores invalid values instead of falling back silently to something else", () => {
    expect(
      getInstancePreferenceOverrides({
        DEFAULT_LOCALE: "fr",
        DEFAULT_TIMEZONE: "Mars/Olympus_Mons",
        DEFAULT_CURRENCY: "BTC",
        DEFAULT_DISTANCE_UNIT: "furlong",
        DEFAULT_VOLUME_UNIT: " gal ",
      }),
    ).toEqual({ volumeUnit: "gal" });
  });
});
