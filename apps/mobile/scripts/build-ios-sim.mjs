#!/usr/bin/env node
// Builds Band for the iOS simulator: `node scripts/build-ios-sim.mjs [Release|Debug]`.
import { buildForSimulator } from "./ios.mjs";

const app = buildForSimulator(process.argv[2] ?? "Release");
console.log(`Built ${app}`);
