import { describe, expect, it } from "vitest";

import { validateProjectInput } from "@/workflows/projects";

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

