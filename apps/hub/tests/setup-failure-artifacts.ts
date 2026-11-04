import { afterAll, beforeEach, onTestFailed } from "vitest";
import { dropStagedLogs, markTestFailed } from "./helpers/failure-artifacts";

// Tells the helpers that a test failed, so they keep the logs before the temp home is deleted.
beforeEach(() => {
  dropStagedLogs();
  onTestFailed(() => markTestFailed());
});
afterAll(() => dropStagedLogs());
