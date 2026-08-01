// Fail-fast runner for the migration 0060 real-PostgreSQL suite.
import { spawn } from "node:child_process";

const bun = process.platform === "win32"
  ? `${process.env.USERPROFILE}\\.bun\\bin\\bun.exe`
  : "bun";
const child = spawn(
  bun,
  ["test", ".\\src\\lib\\line\\migration-0060.pg.test.ts"],
  {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, WSN_0060_REQUIRE: "1" },
    shell: false,
  },
);

child.on("exit", (code) => process.exit(code ?? 1));
