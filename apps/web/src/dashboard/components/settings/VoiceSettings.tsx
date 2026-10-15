import { Button, Input, Switch } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { VOICE_STATUS_KEY } from "../../../components/ai-elements/prompt-input-mic";
import { trpc } from "../../../lib/trpc-client";
import { SettingsRow } from "./SettingsRow";

interface Form {
  enabled: boolean;
  baseUrl: string;
  model: string;
  language: string;
  hostId: string;
  apiKeyItemId: string;
}

const EMPTY: Form = {
  enabled: false,
  baseUrl: "",
  model: "",
  language: "",
  hostId: "",
  apiKeyItemId: "",
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Settings > Voice: the one speech-to-text endpoint behind the composer's mic. Admin only. */
export function VoiceSettings() {
  const queryClient = useQueryClient();
  const saved = useQuery({
    queryKey: ["voice.config"],
    queryFn: () => trpc.voice.config.query(),
  });
  const vault = useQuery({
    queryKey: ["vault.list"],
    queryFn: () => trpc.vault.list.query(),
  });
  const hosts = useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await trpc.hosts.list.query()).hosts,
  });
  const [form, setForm] = useState<Form>(EMPTY);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);

  useEffect(() => {
    if (saved.data && !dirty) setForm({ ...EMPTY, ...saved.data } as Form);
  }, [saved.data, dirty]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
    setTested(null);
  };

  const body = () => ({
    enabled: form.enabled,
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim(),
    language: form.language.trim(),
    hostId: form.hostId,
    apiKeyItemId: form.apiKeyItemId,
  });

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      await trpc.settings.update.mutate({ voice: body() });
      setDirty(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: VOICE_STATUS_KEY }),
        queryClient.invalidateQueries({ queryKey: ["voice.config"] }),
      ]);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setError(null);
    setTested(null);
    try {
      const { enabled: _enabled, ...endpoint } = body();
      const result = await trpc.voice.test.mutate(endpoint);
      const host = hosts.data?.find((h) => h.id === result.hostId)?.name;
      setTested(
        result.hostId === "local"
          ? "Connected. The hub reached the endpoint."
          : `Connected. ${host ?? result.hostId} reached the endpoint.`,
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  if (saved.isError) {
    return (
      <SettingsRow variant="stacked" label="Voice dictation">
        <p
          role="alert"
          className="text-xs text-muted-foreground"
          data-testid="settings__voice-denied"
        >
          Setting up voice needs an admin token.
        </p>
      </SettingsRow>
    );
  }

  const keys = (vault.data?.items ?? []).filter((i) => i.kind === "api_key");
  const onlineHosts = (hosts.data ?? []).filter((h) => h.usable && h.id !== "local");
  const ready = form.baseUrl.trim() !== "" && form.model.trim() !== "";

  return (
    <>
      <SettingsRow
        htmlFor="voice-enabled"
        label="Voice dictation"
        description="Show a mic in the chat composer. Audio goes to the hub, which sends it to the endpoint below. Nothing is installed or started by Band."
      >
        <Switch
          id="voice-enabled"
          data-testid="settings__voice-enabled"
          checked={form.enabled}
          onCheckedChange={(v) => set("enabled", v)}
        />
      </SettingsRow>

      <SettingsRow
        variant="responsive"
        htmlFor="voice-base-url"
        label="Base URL"
        description="An OpenAI-compatible speech-to-text server. Band posts to <base URL>/audio/transcriptions."
      >
        <Input
          id="voice-base-url"
          data-testid="settings__voice-base-url"
          placeholder="https://api.openai.com/v1"
          value={form.baseUrl}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("baseUrl", e.target.value)}
          className="h-8 w-full text-sm sm:w-[22rem]"
        />
      </SettingsRow>

      <SettingsRow
        variant="responsive"
        htmlFor="voice-model"
        label="Model"
        description="For example whisper-1, gpt-4o-transcribe, whisper-large-v3 (Groq) or an mlx-community model."
      >
        <Input
          id="voice-model"
          data-testid="settings__voice-model"
          placeholder="whisper-1"
          value={form.model}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("model", e.target.value)}
          className="h-8 w-full text-sm sm:w-[22rem]"
        />
      </SettingsRow>

      <SettingsRow
        variant="responsive"
        htmlFor="voice-language"
        label="Language"
        description="An ISO-639-1 code such as en. Leave empty and the provider detects it."
      >
        <Input
          id="voice-language"
          data-testid="settings__voice-language"
          placeholder="Auto-detect"
          value={form.language}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("language", e.target.value)}
          className="h-8 w-full text-sm sm:w-[10rem]"
        />
      </SettingsRow>

      <SettingsRow
        variant="responsive"
        htmlFor="voice-key"
        label="API key"
        description="A key from Settings > Credentials. A local server needs none."
      >
        <select
          id="voice-key"
          data-testid="settings__voice-key"
          value={form.apiKeyItemId}
          onChange={(e) => set("apiKeyItemId", e.target.value)}
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm sm:w-[22rem]"
        >
          <option value="">No key</option>
          {keys.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </SettingsRow>

      <SettingsRow
        variant="responsive"
        htmlFor="voice-host"
        label="Run on"
        description="The hub calls the endpoint itself. Pick a host to have its worker call it, for a server on that machine's localhost."
      >
        <select
          id="voice-host"
          data-testid="settings__voice-host"
          value={form.hostId}
          onChange={(e) => set("hostId", e.target.value)}
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm sm:w-[22rem]"
        >
          <option value="">The hub</option>
          {onlineHosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </SettingsRow>

      <SettingsRow variant="stacked">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="settings__voice-test"
            disabled={busy !== null || !ready}
            onClick={() => void test()}
          >
            {busy === "test" ? "Testing" : "Test connection"}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="settings__voice-save"
            disabled={busy !== null || !dirty}
            onClick={() => void save()}
          >
            Save
          </Button>
          {tested ? (
            <span role="status" className="text-xs text-green-600" data-testid="settings__voice-ok">
              {tested}
            </span>
          ) : null}
        </div>
        {error ? (
          <p
            role="alert"
            className="mt-2 text-xs text-destructive"
            data-testid="settings__voice-error"
          >
            {error}
          </p>
        ) : null}
      </SettingsRow>

      <SettingsRow
        variant="stacked"
        label="Run a local server"
        description="Band does not install or start one. On a Mac with Apple Silicon:"
      >
        <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">
          {`uv tool install --force "mlx-audio[server]" --prerelease=allow\nmlx_audio.server --host 127.0.0.1 --port 8000`}
        </pre>
        <p className="mt-2 text-xs text-muted-foreground">
          Then use base URL http://127.0.0.1:8000/v1, a model such as
          mlx-community/whisper-large-v3-turbo-asr-fp16, and Run on this Mac. On Linux, speaches
          runs in Docker. See the voice dictation guide in the docs.
        </p>
      </SettingsRow>
    </>
  );
}
