import type { SpeechTranscribeRequest, SpeechTranscribeResult } from "@band-app/host-api";
import { requestTranscription, SpeechError } from "@band-app/shared/speech-transcription";

/**
 * Makes the OpenAI-compatible transcription call from this machine. A provider failure is a
 * result with its code, so it survives the worker link; the message never holds the key.
 */
export async function transcribeLocally(
  req: SpeechTranscribeRequest,
): Promise<SpeechTranscribeResult> {
  try {
    return await requestTranscription(req);
  } catch (err) {
    if (err instanceof SpeechError) return { error: { code: err.code, message: err.message } };
    throw err;
  }
}
