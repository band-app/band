#!/usr/bin/env node
// The worker runs from TypeScript source through tsx, like the other workspace
// packages. Packaging it as a bundle is a later step.
import { register } from "tsx/esm/api";

register();
await import("../src/main.ts");
