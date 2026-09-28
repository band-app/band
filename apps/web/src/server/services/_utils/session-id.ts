import { z } from "zod";

/**
 * Shape of an agent session id a client may hand Band (a session to resume
 * or switch to). The id ends up as a vendor CLI argument
 * (`claude --resume <id>`, `codex resume <id>`), so it must not start with
 * `-`, where the CLI would read it as a flag. Real ids are UUIDs or
 * `ses_…`-style tokens.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;

export const sessionIdSchema = z.string().regex(SESSION_ID_PATTERN, "invalid session id");
