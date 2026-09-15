import { describe, expect, it } from "vitest";
import { centsToDollarsInput, describeProject, dollarsInputToCents, formatClock, formatWindow } from "../editor/src/lib/format.js";
import { editProject, selectPreset, setBlockedMerchants } from "../editor/src/lib/project.js";
import { applyPreset, presetById, PRESETS } from "../src/profile/presets.js";
import { profileSchema } from "../src/profile/schema.js";

const safe = () => applyPreset(presetById("safe")!, ["temu.com"]);

describe("preset selection", () => {
  it("applies every preset-controlled setting and keeps blocked merchants", () => {
    const coffee = selectPreset(safe(), "old-man-coffee");
    expect(coffee).toMatchObject({ preset: "old-man-coffee", per_transaction_cap_cents: 1500, blocked_merchants: ["temu.com"] });
    expect(coffee.quiet_hours).toEqual({ start: "21:00", end: "07:00" });

    const allIn = selectPreset(coffee, "all-in");
    expect(allIn.quiet_hours).toBeUndefined();
    expect(allIn.blocked_categories).toEqual([]);
    expect(allIn.blocked_merchants).toEqual(["temu.com"]);
  });

  it("Custom keeps the current values", () => {
    const custom = selectPreset(safe(), "custom");
    expect(custom).toEqual({ ...safe(), preset: "custom" });
  });

  it("switches to Custom on any setting edit, but not on blocked merchant edits", () => {
    expect(editProject(safe(), { daily_cap_cents: 10_000 }).preset).toBe("custom");
    expect(setBlockedMerchants(safe(), ["temu.com", "shein.com"]).preset).toBe("safe");
  });

  it("every preset, applied in the editor, produces a profile the gateway accepts", () => {
    for (const preset of PRESETS) {
      const project = selectPreset(safe(), preset.id);
      expect(() =>
        profileSchema.parse({ version: 1, default_project: "p", timezone: "UTC", projects: { p: project } }),
      ).not.toThrow();
    }
  });
});

describe("money and time formatting", () => {
  it("parses dollar input into cents", () => {
    expect(dollarsInputToCents("50")).toBe(5000);
    expect(dollarsInputToCents("$1,234.5")).toBe(123450);
    expect(dollarsInputToCents("0.99")).toBe(99);
    expect(dollarsInputToCents("12.345")).toBeNull();
    expect(dollarsInputToCents("0")).toBeNull();
    expect(dollarsInputToCents("")).toBeNull();
    expect(dollarsInputToCents("abc")).toBeNull();
  });

  it("round-trips cents to input text", () => {
    for (const cents of [100, 150, 5000, 123456]) {
      expect(dollarsInputToCents(centsToDollarsInput(cents))).toBe(cents);
    }
    expect(centsToDollarsInput(5000)).toBe("50");
    expect(centsToDollarsInput(150)).toBe("1.50");
  });

  it("formats look-back windows", () => {
    expect(formatWindow(7, 0)).toBe("7 days");
    expect(formatWindow(1, 12)).toBe("1 day 12 hours");
    expect(formatWindow(0, 1)).toBe("1 hour");
  });

  it("formats clock times", () => {
    expect(formatClock("00:00")).toBe("12am");
    expect(formatClock("07:30")).toBe("7:30am");
    expect(formatClock("12:00")).toBe("12pm");
    expect(formatClock("23:00")).toBe("11pm");
  });

  it("summarizes a project in plain English", () => {
    const lines = describeProject(selectPreset(safe(), "old-man-coffee"));
    expect(lines[0]).toBe("Up to $15 per purchase and $30 in the past 24 hours.");
    expect(lines).toContain("No more than $75 in any 7 days.");
    expect(lines).toContain("Blocks merchants it can't categorize.");
    expect(lines).toContain("Never shops at: temu.com.");
    expect(lines).toContain("No purchases from 9pm to 7am.");
  });
});
