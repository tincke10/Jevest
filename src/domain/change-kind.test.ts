import { describe, expect, it } from "vitest";
import { PROFILE_CHANGE_KINDS } from "./change-kind.js";

describe("PROFILE_CHANGE_KINDS", () => {
  it("lists the four hunk-profile change kinds, in the order the question set offers them", () => {
    expect(PROFILE_CHANGE_KINDS).toEqual([
      "add-behavior",
      "modify-behavior",
      "delete",
      "rename-or-format",
    ]);
  });
});
