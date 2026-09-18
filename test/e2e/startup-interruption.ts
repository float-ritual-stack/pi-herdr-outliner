import assert from "node:assert/strict";
import { runHerdrScenario } from "./herdr-runner";

const result = await runHerdrScenario({
  name: "startup-interruption",
  async prepare() {
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => setTimeout(resolve, 200));
      process.kill(process.pid, "SIGINT");
    });
  },
  async run() {
    throw new Error("Interrupted scenario must not run");
  },
});

assert.equal(result.status, "failed");
assert.match(result.error, /Herdr scenario interrupted by SIGINT/);
const isolation: unknown = await Bun.file(`${result.artifactDirectory}/isolation.json`).json();
assert.ok(typeof isolation === "object" && isolation !== null);
assert.ok("sessionName" in isolation && typeof isolation.sessionName === "string");
assert.ok("effectiveEnvironment" in isolation && typeof isolation.effectiveEnvironment === "object" && isolation.effectiveEnvironment !== null);
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_") && !key.startsWith("OUTLINER_")),
);
for (const [key, value] of Object.entries(isolation.effectiveEnvironment)) {
  assert.ok(typeof value === "string");
  environment[key] = value;
}
const statusProcess = Bun.spawn(["herdr", "--session", isolation.sessionName, "status", "server", "--json"], {
  env: environment,
  stdout: "pipe",
  stderr: "pipe",
  timeout: 5_000,
  killSignal: "SIGKILL",
});
const [statusExitCode, statusOutput] = await Promise.all([
  statusProcess.exited,
  new Response(statusProcess.stdout).text(),
  new Response(statusProcess.stderr).text(),
]);
const status: unknown = JSON.parse(statusOutput);
assert.equal(statusExitCode, 0);
assert.ok(typeof status === "object" && status !== null && "running" in status && typeof status.running === "boolean");
if (status.running) {
  const stop = Bun.spawn(["herdr", "--session", isolation.sessionName, "server", "stop"], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
    killSignal: "SIGKILL",
  });
  const [stopExitCode] = await Promise.all([
    stop.exited,
    new Response(stop.stdout).text(),
    new Response(stop.stderr).text(),
  ]);
  assert.equal(stopExitCode, 0, "Regression probe must clean up the leaked private server");
}
assert.equal(status.running, false, "Cancelled preparation must not start a detached server after cleanup");
process.stdout.write(`${JSON.stringify({ status: "passed", scenario: "startup-interruption", artifactDirectory: result.artifactDirectory })}\n`);
