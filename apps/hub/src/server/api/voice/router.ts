import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { SpeechError, voiceService } from "../../services/voice-service";
import { adminProcedure, publicProcedure, t } from "../trpc";

/**
 * `voice.*`: speech-to-text for the composer mic. `status` is for
 * every paired device and says only whether the mic can work. `config` and `test` are admin
 * only. The audio itself goes to `POST /api/voice/transcribe`, because tRPC's JSON body is a
 * poor fit for a binary clip. The MCP endpoint and the worker relay leave the whole router out.
 */
function speechTrpcError(err: unknown): never {
  if (err instanceof SpeechError) {
    const code =
      err.code === "not_configured"
        ? "PRECONDITION_FAILED"
        : err.code === "too_large"
          ? "PAYLOAD_TOO_LARGE"
          : err.code === "timeout"
            ? "TIMEOUT"
            : "INTERNAL_SERVER_ERROR";
    throw new TRPCError({ code, message: err.message });
  }
  throw err;
}

const testInput = z
  .object({
    baseUrl: z.string().max(500).optional(),
    model: z.string().max(200).optional(),
    language: z.string().max(10).optional(),
    hostId: z.string().max(100).optional(),
    apiKeyItemId: z.string().max(100).optional(),
  })
  .optional();

export const voiceRouter = t.router({
  status: publicProcedure.query(() => voiceService.status()),

  config: adminProcedure.query(() => voiceService.config()),

  test: adminProcedure.input(testInput).mutation(async ({ input }) => {
    try {
      return await voiceService.test(input);
    } catch (err) {
      return speechTrpcError(err);
    }
  }),
});

export type VoiceRouter = typeof voiceRouter;
