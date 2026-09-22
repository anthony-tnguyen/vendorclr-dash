import { describe, expect, it } from "vitest";

import { requirementSourceLabel, validateProjectInput } from "@/workflows/projects";

describe("validateProjectInput", () => {
  it("rejects a blank project name before any persistence attempt", () => {
    expect(() => validateProjectInput({ name: "   ", status: "active" })).toThrow(
      "Project name is required",
    );
  });

  it("normalizes a valid project name and location", () => {
    expect(
      validateProjectInput({
        name: " Harbor Tower ",
        location: " 100 Main St ",
        status: "active",
      }),
    ).toEqual({
      name: "Harbor Tower",
      location: "100 Main St",
      status: "active",
    });
  });
});

describe("requirementSourceLabel", () => {
  it("explains the resolver precedence source without reimplementing it in the client", () => {
    expect(requirementSourceLabel("assignment_profile")).toBe("Assignment profile");
    expect(requirementSourceLabel("project_override")).toBe("Project override");
  });
});
