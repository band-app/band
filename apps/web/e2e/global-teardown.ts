import { sweepSimulatorTestDevices } from "../../../scripts/test-env.mjs";

// Deletes the simulator devices this run named with its `band-test-*` prefix, even when specs
// failed, and any older run's leftovers. Only names with that prefix are touched.
export default function globalTeardown(): void {
  sweepSimulatorTestDevices({ prefix: process.env.BAND_SIMULATOR_NAME_PREFIX });
}
