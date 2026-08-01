// Fail-fast runner for the migration 0059 real-PostgreSQL suite. Spawns
// `bun test` with WSN_0059_REQUIRE=1 so the suite throws instead of silently
// skipping when ALLOW_DISPOSABLE_POSTGRES_TESTS isn't set or PostgreSQL 17
// isn't reachable. Cross-platform: env is set via spawn, not shell syntax.
import { spawn } from "node:child_process";

const child = spawn(
  "bun",
  ["test", "src/lib/line/migration-0059.pg.test.ts"],
  {
    stdio: "inherit",
    env: { ...process.env, WSN_0059_REQUIRE: "1" },
    shell: process.platform === "win32",
  },
);

child.on("exit", (code) => process.exit(code ?? 1));
