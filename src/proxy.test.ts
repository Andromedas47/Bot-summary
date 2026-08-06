import { describe, expect, it, mock } from "bun:test";
import { NextRequest } from "next/server";

// proxy() calls supabase.auth.getUser(), which makes a real network call
// against Supabase Auth. Stub createServerClient so "no session" resolves
// instantly without touching the network.
mock.module("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
    },
  }),
}));

const { proxy } = await import("./proxy");

function postTo(pathname: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, { method: "POST" });
}

describe("proxy — LINE webhook auth bypass", () => {
  it("lets POST /api/webhook/line reach the route without a Supabase session", async () => {
    const res = await proxy(postTo("/api/webhook/line"));
    expect(res.status).not.toBe(401);
  });

  it("still returns 401 for another protected API route without a session", async () => {
    const res = await proxy(postTo("/api/settlement"));
    expect(res.status).toBe(401);
  });

  it("does not exempt a webhook-like path that isn't the exact LINE webhook route", async () => {
    const res = await proxy(postTo("/api/webhook/other"));
    expect(res.status).toBe(401);
  });

  it("does not exempt a path that merely starts with the webhook prefix", async () => {
    const res = await proxy(postTo("/api/webhookzzz"));
    expect(res.status).toBe(401);
  });
});
