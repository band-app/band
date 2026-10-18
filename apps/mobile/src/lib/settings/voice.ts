/**
 * The Voice screen's form and messages. Pure, so the tests run under Node.
 */

export type VoiceConfig = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  language: string;
  hostId: string;
  apiKeyItemId: string;
};

export function voiceBody(config: VoiceConfig, enabled: boolean): VoiceConfig {
  return {
    enabled,
    baseUrl: config.baseUrl.trim(),
    model: config.model.trim(),
    language: config.language.trim(),
    hostId: config.hostId,
    apiKeyItemId: config.apiKeyItemId,
  };
}

/** The endpoint the Test call sends: the saved config without `enabled`. */
export function voiceTestBody(config: VoiceConfig) {
  const { enabled: _enabled, ...endpoint } = voiceBody(config, config.enabled);
  return endpoint;
}

export function voiceReady(config: VoiceConfig): boolean {
  return config.baseUrl.trim() !== "" && config.model.trim() !== "";
}

export function testMessage(hostId: string, hostName: string | undefined): string {
  return hostId === "local"
    ? "Connected. The hub reached the endpoint."
    : `Connected. ${hostName ?? hostId} reached the endpoint.`;
}
