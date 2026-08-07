import { afterEach, describe, expect, it } from "bun:test";
import { getRuntimeEnvironment } from "./runtime-environment";

const original = process.env.VERCEL_ENV;

afterEach(() => {
  if (original === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = original;
});

describe("getRuntimeEnvironment", () => {
  it("resolves Vercel Production to 'production'", () => {
    process.env.VERCEL_ENV = "production";
    expect(getRuntimeEnvironment()).toBe("production");
  });

  it("resolves Vercel Preview to 'preview'", () => {
    process.env.VERCEL_ENV = "preview";
    expect(getRuntimeEnvironment()).toBe("preview");
  });

  it("resolves Vercel Development to 'development'", () => {
    process.env.VERCEL_ENV = "development";
    expect(getRuntimeEnvironment()).toBe("development");
  });

  it("fails safe to 'development' when VERCEL_ENV is missing (local/test)", () => {
    delete process.env.VERCEL_ENV;
    expect(getRuntimeEnvironment()).toBe("development");
  });

  it("fails safe to 'development' for an unrecognized value — never silently 'production'", () => {
    process.env.VERCEL_ENV = "staging-typo";
    expect(getRuntimeEnvironment()).toBe("development");
  });
});
