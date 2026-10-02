/**
 * The kinds of change the hunk profile (stage 2, FR-3.2) classifies a hunk
 * into. Domain vocabulary: the profile question set asks Jev to pick one,
 * and `.jevest.yml`'s `skipChangeKinds` may only name these (anything else
 * could never match).
 *
 * Pure: no ports, no I/O.
 */
export const PROFILE_CHANGE_KINDS = [
  "add-behavior",
  "modify-behavior",
  "delete",
  "rename-or-format",
] as const;

export type ProfileChangeKind = (typeof PROFILE_CHANGE_KINDS)[number];
