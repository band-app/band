import { SESSION_ID_PATTERN } from "@band-app/shared/chat-events";
import { z } from "zod";

export { SESSION_ID_PATTERN };

export const sessionIdSchema = z.string().regex(SESSION_ID_PATTERN, "invalid session id");
