// Fail-fast runner for the migration 0060 real-PostgreSQL suite.
import { spawn } from "node:child_process";

const child = spawn(
  "bun",
  ["test", "src/lib/line/migration-0060.pg.test.ts"],
  {
    stdio: "inherit",
    env: { ...process.env, WSN_0060_REQUIRE: "1" },
    shell: process.platform === "win32",
  },
);

child.on("exit", (code) => process.exit(code ?? 1));
