import { applyPreset, presetById } from "../../../src/profile/presets.js";
import type { PresetId, ProjectPolicy } from "../../../src/profile/schema.js";

/** Any change to a preset-controlled setting makes the project Custom. */
export function editProject(project: ProjectPolicy, patch: Partial<ProjectPolicy>): ProjectPolicy {
  return { ...project, ...patch, preset: "custom" };
}

/** Blocked merchants aren't part of presets, so editing them keeps the current preset. */
export function setBlockedMerchants(project: ProjectPolicy, merchants: string[]): ProjectPolicy {
  return { ...project, blocked_merchants: merchants };
}

/** A named preset replaces every preset-controlled setting; Custom keeps the current values. */
export function selectPreset(project: ProjectPolicy, id: PresetId): ProjectPolicy {
  const preset = presetById(id);
  return preset ? applyPreset(preset, project.blocked_merchants) : { ...project, preset: "custom" };
}
