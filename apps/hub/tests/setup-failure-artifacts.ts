import { beforeEach, onTestFailed } from "vitest";
import { markTestFailed } from "./helpers/failure-artifacts";

// Tells the helpers that a test failed, so they keep the logs before the temp home is deleted.
beforeEach(() => {
  onTestFailed(() => markTestFailed());
});
