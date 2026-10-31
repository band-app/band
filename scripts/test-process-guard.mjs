// Preloaded (`node --import`) into every node process a test run starts, through
// NODE_OPTIONS. When the process that owns the run is gone, this one exits, so a
// band-worker, terminal daemon, agent daemon or stub agent cannot outlive a vitest
// or node:test process that died without running its cleanup (SIGKILL, timeout).
// Does nothing without TEST_PROCESS_GUARD_OWNER_PID, which the test setup files set.
const owner = Number(process.env.TEST_PROCESS_GUARD_OWNER_PID);
const intervalMs = Number(process.env.TEST_PROCESS_GUARD_INTERVAL_MS) || 2000;

function ownerAlive() {
  try {
    process.kill(owner, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but is not ours; only ESRCH means gone.
    return err?.code === "EPERM";
  }
}

if (Number.isInteger(owner) && owner > 1 && owner !== process.pid) {
  setInterval(() => {
    if (!ownerAlive()) process.kill(process.pid, "SIGKILL");
  }, intervalMs).unref();
}
