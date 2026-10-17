import { HostOfflineError } from "@band-app/host-api";
import {
  assertEndpointUrl,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  requestTranscription,
  SpeechError,
  type SpeechErrorCode,
  scrubSecrets,
  silentWav,
  type VoiceSettings,
  type VoiceStatus,
  WORKER_TRANSCRIBE_TIMEOUT_MS,
} from "@band-app/shared/speech-transcription";

import { hostRegistry } from "../infra/host/registry";
import { settingsService } from "./settings-service";
import { vaultService } from "./vault-service";

const LOCAL_HOST_ID = "local";

/** Raised for a config problem or a provider failure. The message never holds the API key. */
export { SpeechError };

function readConfig(): VoiceSettings {
  return settingsService.get().voice ?? {};
}

/** Why the mic cannot work with this config, or undefined when it can. */
function problem(config: VoiceSettings): string | undefined {
  if (!config.enabled) return "Voice dictation is off. Set it up in Settings > Voice.";
  if (!config.baseUrl?.trim() || !config.model?.trim()) {
    return "Voice dictation needs a base URL and a model. Set them in Settings > Voice.";
  }
  return undefined;
}

/**
 * Speech-to-text for the composer mic. One hub-wide OpenAI-compatible
 * endpoint. The hub calls it itself, or has a worker call it when `hostId` is set, which is how a
 * server on a Mac's loopback is reached from a hub elsewhere. Clients send audio to the hub only,
 * and the key is read from the vault here and goes nowhere else.
 */
class VoiceService {
  status(): VoiceStatus {
    const reason = problem(readConfig());
    return {
      available: reason === undefined,
      ...(reason ? { reason } : {}),
      maxBytes: MAX_AUDIO_BYTES,
      maxSeconds: MAX_AUDIO_SECONDS,
    };
  }

  /** The saved endpoint, for the settings form. The key is only a vault item id. */
  config(): VoiceSettings {
    const c = readConfig();
    return {
      enabled: c.enabled === true,
      baseUrl: c.baseUrl ?? "",
      model: c.model ?? "",
      language: c.language ?? "",
      hostId: c.hostId ?? "",
      apiKeyItemId: c.apiKeyItemId ?? "",
    };
  }

  async transcribe(audio: Uint8Array, mimeType: string): Promise<{ text: string }> {
    const config = readConfig();
    const reason = problem(config);
    if (reason) throw new SpeechError("not_configured", reason);
    return this.send(config, audio, mimeType);
  }

  /**
   * Sends a one-second silent clip to `override` (the unsaved form) or the saved endpoint. A
   * provider may answer an empty text, which still proves the URL, key and model work.
   */
  async test(override?: VoiceSettings): Promise<{ ok: true; hostId: string }> {
    const config = { ...readConfig(), ...override, enabled: true };
    if (!config.baseUrl?.trim()) {
      throw new SpeechError("not_configured", "Enter a base URL first.");
    }
    if (!config.model?.trim()) throw new SpeechError("not_configured", "Enter a model first.");
    await this.send(config, silentWav(1), "audio/wav");
    return { ok: true, hostId: config.hostId || LOCAL_HOST_ID };
  }

  private async send(
    config: VoiceSettings,
    audio: Uint8Array,
    mimeType: string,
  ): Promise<{ text: string }> {
    if (audio.byteLength === 0) throw new SpeechError("bad_response", "The recording is empty.");
    if (audio.byteLength > MAX_AUDIO_BYTES) {
      throw new SpeechError("too_large", "The recording is over 25 MB.");
    }
    const baseUrl = assertEndpointUrl(config.baseUrl ?? "").toString();
    const model = (config.model ?? "").trim();
    const language = config.language?.trim() || undefined;
    const apiKey = await this.apiKey(config.apiKeyItemId);

    try {
      const hostId = config.hostId?.trim();
      if (!hostId || hostId === LOCAL_HOST_ID) {
        return await requestTranscription({ baseUrl, apiKey, model, language, audio, mimeType });
      }
      let host: ReturnType<typeof hostRegistry.hostById>;
      try {
        host = hostRegistry.hostById(hostId);
      } catch {
        throw new SpeechError("host_offline", `Host ${hostId} is not registered.`);
      }
      let result: Awaited<ReturnType<typeof host.speech.transcribe>>;
      try {
        result = await withTimeout(
          host.speech.transcribe({ baseUrl, apiKey, model, language, audio, mimeType }),
          WORKER_TRANSCRIBE_TIMEOUT_MS,
        );
      } catch (err) {
        if (err instanceof HostOfflineError) {
          throw new SpeechError("host_offline", `Host ${hostId} is offline.`);
        }
        if (err instanceof SpeechError) throw err;
        throw new SpeechError(
          "unreachable",
          `Host ${hostId} could not transcribe: ${scrubSecrets(String((err as Error)?.message ?? err), apiKey)}`,
        );
      }
      if (result.error) {
        throw new SpeechError(
          result.error.code as SpeechErrorCode,
          scrub(result.error.message, apiKey),
        );
      }
      return { text: result.text ?? "" };
    } catch (err) {
      if (err instanceof SpeechError) {
        // Defence in depth: the message is built without the key, and scrubbed again here.
        throw new SpeechError(err.code, scrub(err.message, apiKey));
      }
      throw err;
    }
  }

  private async apiKey(itemId: string | undefined): Promise<string | undefined> {
    if (!itemId) return undefined;
    try {
      const { kind, value } = await vaultService.getCredential(itemId);
      if (kind !== "api_key") throw new Error("not an API key item");
      return value || undefined;
    } catch {
      throw new SpeechError(
        "not_configured",
        "The API key item is missing from the vault or is not an API key. Pick it again in Settings > Voice.",
      );
    }
  }
}

function scrub(message: string, apiKey: string | undefined): string {
  return scrubSecrets(message, apiKey);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SpeechError("timeout", "The host did not answer in time.")),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const voiceService = new VoiceService();
