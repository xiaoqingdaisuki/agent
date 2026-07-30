import { describe, it, expect } from "vitest";
import { tools } from "../../src/tools/index.js";
import { registry, getToolsForUser, getToolMetadata } from "../../src/tools/registry.js";

describe("Tool Registry", () => {
  it("uses provider-safe names for bound tools", () => {
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
  });
  it("returns default tools", () => {
    const tools = registry.getAllTools();
    expect(tools.length).toBeGreaterThanOrEqual(4);
  });

  it("returns all descriptors", () => {
    const descs = registry.getDescriptors();
    expect(descs.length).toBeGreaterThanOrEqual(4);
  });

  it("finds descriptor by name", () => {
    const desc = registry.getDescriptor("math.calculate");
    expect(desc).toBeDefined();
    expect(desc?.name).toBe("math.calculate");
    expect(desc?.risk_level).toBe("R0");
  });

  it("returns undefined for unknown tool", () => {
    expect(registry.getDescriptor("nonexistent")).toBeUndefined();
  });

  it("R0 tools visible without permissions", () => {
    const visible = registry.getVisibleTools([]);
    expect(visible.length).toBeGreaterThanOrEqual(1); // math.calculate
  });

  it("R1 tools require permissions", () => {
    const without = registry.getVisibleDescriptors([]);
    const withPerms = registry.getVisibleDescriptors(["web.read", "web.search"]);

    const withoutMap = new Map(without.map((d) => [d.name as string, d]));
    const withMap = new Map(withPerms.map((d) => [d.name as string, d]));

    // web.read and web.search exist but are unavailable without perms
    expect(withoutMap.get("web.read")?.available).toBe(false);
    expect(withoutMap.get("web.search")?.available).toBe(false);
    // But they should be available with perms
    expect(withMap.get("web.read")?.available).toBe(true);
    expect(withMap.get("web.search")?.available).toBe(true);
  });

  it("metadata has required fields", () => {
    const meta = getToolMetadata([]);
    for (const m of meta) {
      expect(m).toHaveProperty("name");
      expect(m).toHaveProperty("title");
      expect(m).toHaveProperty("description");
      expect(m).toHaveProperty("category");
      expect(m).toHaveProperty("risk_level");
      expect(m).toHaveProperty("available");
    }
  });

  it("groups tools by category", () => {
    const cats = registry.getCategories();
    expect(cats).toHaveProperty("COMPUTE");
    expect(cats).toHaveProperty("READ");
    expect(cats).toHaveProperty("SEARCH");
  });

  it("global getToolsForUser returns all by default", () => {
    const tools = getToolsForUser();
    expect(tools.length).toBeGreaterThanOrEqual(4);
  });
});
