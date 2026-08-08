import { describe, expect, it } from "bun:test";
import {
  createSweepCoordinator,
  MIN_SWEEP_INTERVAL_MS,
} from "./sweep-coordinator";

describe("pending produce sweep coordination", () => {
  it("runs at most once per configured interval", async () => {
    const coordinator = createSweepCoordinator();
    let calls = 0;
    const task = async () => ++calls;

    expect(await coordinator.run(task, 1_000)).toEqual({
      status: "executed",
      value: 1,
    });
    expect(await coordinator.run(task, 1_000 + MIN_SWEEP_INTERVAL_MS - 1))
      .toEqual({ status: "rate_limited", retryAfterMs: 1 });
    expect(await coordinator.run(task, 1_000 + MIN_SWEEP_INTERVAL_MS)).toEqual({
      status: "executed",
      value: 2,
    });
    expect(calls).toBe(2);
  });

  it("coalesces overlapping work into one execution", async () => {
    const coordinator = createSweepCoordinator();
    let calls = 0;
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => { release = resolve; });
    const task = async () => {
      calls += 1;
      return pending;
    };

    const first = coordinator.run(task, 2_000);
    const second = coordinator.run(task, 2_001);
    release("done");

    expect(await first).toEqual({ status: "executed", value: "done" });
    expect(await second).toEqual({ status: "coalesced", value: "done" });
    expect(calls).toBe(1);
  });

  it("applies cooldown after an error to prevent immediate retry loops", async () => {
    const coordinator = createSweepCoordinator();
    const failedTask = async () => { throw new Error("boom"); };

    await expect(coordinator.run(failedTask, 3_000)).rejects.toThrow("boom");
    await expect(coordinator.run(async () => "unexpected", 3_001)).resolves
      .toEqual({
        status: "rate_limited",
        retryAfterMs: MIN_SWEEP_INTERVAL_MS - 1,
      });
  });
});

describe("pending produce scheduler contract", () => {
  it("documents one scheduler with a one-minute minimum cadence", async () => {
    const readme = await Bun.file(new URL(
      "../../../../../README.md",
      import.meta.url,
    )).text();

    expect(readme).toContain("no more than once per minute");
    expect(readme).toContain("exactly one durable scheduler");
    expect(readme).not.toMatch(/Call the route every 1.+2 seconds/);
  });
});
