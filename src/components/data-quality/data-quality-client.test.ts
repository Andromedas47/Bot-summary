import { describe, expect, it } from "bun:test";
import {
  postIgnoreDataQualityIssue,
  postResolveDataQualityIssue,
  requireResolutionNote,
} from "./data-quality-client";

describe("requireResolutionNote", () => {
  it("blocks empty/whitespace notes", () => {
    expect(requireResolutionNote("")).toBeNull();
    expect(requireResolutionNote("   ")).toBeNull();
    expect(requireResolutionNote("fixed manually")).toBe("fixed manually");
  });
});

describe("postResolveDataQualityIssue", () => {
  it("calls the resolve API with exact issueKey + note", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const result = await postResolveDataQualityIssue(
      { issueKey: "k1", note: "  fixed  " },
      async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ id: "row-1", status: "RESOLVED" }), { status: 200 });
      },
    );
    expect(calls).toEqual([
      { url: "/api/admin/data-quality/resolve", body: { issueKey: "k1", note: "fixed" } },
    ]);
    expect(result).toEqual({ ok: true, status: "RESOLVED" });
  });

  it("does not call the API when the note is empty", async () => {
    let called = false;
    const result = await postResolveDataQualityIssue({ issueKey: "k1", note: "  " }, async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("surfaces the API error without a fake success", async () => {
    const result = await postResolveDataQualityIssue({ issueKey: "k1", note: "x" }, async () =>
      new Response(JSON.stringify({ error: "Admin authorization is required" }), { status: 403 }),
    );
    expect(result).toEqual({ ok: false, error: "Admin authorization is required" });
  });
});

describe("postIgnoreDataQualityIssue", () => {
  it("calls the ignore API with exact issueKey + note", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const result = await postIgnoreDataQualityIssue(
      { issueKey: "k2", note: "known issue" },
      async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ id: "row-2", status: "IGNORED" }), { status: 200 });
      },
    );
    expect(calls).toEqual([
      { url: "/api/admin/data-quality/ignore", body: { issueKey: "k2", note: "known issue" } },
    ]);
    expect(result).toEqual({ ok: true, status: "IGNORED" });
  });
});
