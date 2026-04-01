/**
 * Registration script for the custom module loader.
 * Passed via `node --import ./tests/register-mock-loader.mjs`.
 */
import { register } from "node:module";
register("./mock-codex-loader.mjs", import.meta.url);
