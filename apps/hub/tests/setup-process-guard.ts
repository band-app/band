// Runs in each test file's process. Every node process a test starts inherits
// these and exits once this process is gone (scripts/test-process-guard.mjs).
const guard = new URL("../../../scripts/test-process-guard.mjs", import.meta.url).href;

process.env.TEST_PROCESS_GUARD_OWNER_PID = String(process.pid);
if (!process.env.NODE_OPTIONS?.includes(guard)) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import ${guard}`]
    .filter(Boolean)
    .join(" ");
}
