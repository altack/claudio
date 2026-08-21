// Talking to supervisord, which is PID 1 inside the claudio container.
//
// Restarting LiteLLM is load-bearing in two places:
//
//   1. After sign-in. LiteLLM registers github_copilot/* deployments at
//      startup against whatever tokens exist then; if the proxy booted before
//      the user authorised, those routes are dead until it restarts.
//   2. Model discovery. supervisor/litellm-start.sh re-runs
//      generate_config.py on every start, so a restart *is* how the model
//      catalog gets refreshed from Copilot.

import { spawn } from "node:child_process";

const SUPERVISOR_CONF = "/etc/supervisor/supervisord.conf";
const TIMEOUT_MS = 5000;

/** Best-effort `supervisorctl restart litellm`. Never rejects. */
export function restartLitellm(): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn(
      "supervisorctl",
      ["-c", SUPERVISOR_CONF, "restart", "litellm"],
      { stdio: "ignore" },
    );
    const done = () => resolve();
    proc.on("close", done);
    proc.on("error", done);
    setTimeout(done, TIMEOUT_MS);
  });
}
