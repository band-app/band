# Voice dictation

The chat composer has a mic button. Tap it, speak, tap it again, and the transcribed text appears at the cursor for you to edit. Band never sends the message for you.

Band does not run speech models. The hub sends each recording to one OpenAI-compatible speech-to-text endpoint that you set up in Settings > Voice. The endpoint is a cloud service such as OpenAI or Groq, or a server you run yourself, such as mlx-audio on a Mac.

## How a recording travels

1. The composer records with the browser's `MediaRecorder` (the Expo app uses `expo-audio`). Chrome and the desktop app produce webm/opus, Safari and the phone produce mp4/aac.
   The hub names the file it sends to the provider (`audio.m4a`, `audio.webm`, and so on) from the first bytes of the clip, not from the request's `Content-Type`, because a client can send a wrong or empty type. The header's type is used only when the bytes match no known container.
2. The client posts the clip to the hub at `POST /api/voice/transcribe`, with its normal device token. It never talks to the speech-to-text provider.
3. The hub makes one non-streaming request, `POST <base URL>/audio/transcriptions`, with the multipart fields `file`, `model`, `response_format=json` and, when set, `language`. The API key goes in an `Authorization: Bearer` header. The hub reads the key from its credential vault, and no client, log line or error message holds it.
4. The hub returns `{ "text": "..." }`.

With **Run on** set to a host, step 3 happens on that machine. The hub sends the clip, the endpoint settings and the key to that host's worker over its existing link, and the worker makes the HTTP call to the base URL from its own network. This is how a hub on a server uses a speech server that listens only on the Mac's `127.0.0.1`. If the host is offline, the client gets "Host X is offline" and nothing is sent anywhere else.

A clip is at most 25 MB (OpenAI's limit) and 10 minutes. The app stops the recording at 10 minutes, and the hub refuses a larger upload. The provider call times out after 2 minutes.

## Set up

Open Settings > Voice (an admin device token is needed). Fill in:

| Field | Meaning |
| --- | --- |
| Voice dictation | The switch that shows the mic. |
| Base URL | The server's OpenAI-compatible root, usually ending in `/v1`. |
| Model | The model name the server expects. |
| Language | Optional ISO-639-1 code such as `en`. Empty lets the provider detect it. |
| API key | A key stored in Settings > Credentials (kind API key). Local servers need none. |
| Run on | The hub, or a host whose worker calls the endpoint for the hub. |

Press **Test connection** before saving. It sends one second of silence with the form's values and reports success, or a plain error: a refused key, an unreachable URL, an unknown model. The error never contains the key.

Until the switch is on and the base URL and model are filled in, the composer shows no mic.

### OpenAI

- Base URL `https://api.openai.com/v1`
- Model `whisper-1`, `gpt-4o-transcribe` or `gpt-4o-mini-transcribe`
- Store the key in Settings > Credentials as an API key, then pick it under API key.

### Groq

- Base URL `https://api.groq.com/openai/v1`
- Model `whisper-large-v3-turbo` or `whisper-large-v3`
- Same key handling.

### mlx-audio on a Mac (local, Apple Silicon)

Band installs and starts nothing, so start the server yourself:

```bash
uv tool install --force "mlx-audio[server]" --prerelease=allow
mlx_audio.server --host 127.0.0.1 --port 8000
```

Then in Settings > Voice:

- Base URL `http://127.0.0.1:8000/v1`
- Model `mlx-community/whisper-large-v3-turbo-asr-fp16`. The server downloads it on the first request, so the first dictation (and Test connection) is slow.
- No key.
- Run on: the Mac, when the hub runs somewhere else. The Mac must run a Band worker (the desktop app's "Use this Mac as a worker", or `band-worker`). When the hub itself runs on that Mac, leave Run on set to the hub.

mlx-audio answers in `ndjson` by default. Band always sends `response_format=json`, so this needs no setting.

### speaches on Linux (local)

```bash
docker run --rm --detach --publish 8000:8000 --name speaches \
  --volume hf-hub-cache:/home/ubuntu/.cache/huggingface/hub \
  ghcr.io/speaches-ai/speaches:latest-cpu
uvx speaches-cli model download Systran/faster-whisper-small
```

Use `:latest-cuda` and `--gpus=all` with an NVIDIA GPU. Then:

- Base URL `http://127.0.0.1:8000/v1`
- Model `Systran/faster-whisper-small`
- Run on: the Linux host, if it is not the hub.

Other servers that implement `/v1/audio/transcriptions` (LocalAI, WhisperKit's `serve`, Mistral's Voxtral API) work with the same fields.

## Who can use it

- Any paired device can dictate. Only an admin device token can read or change the endpoint, and the key is never returned by any call.
- An agent cannot use dictation. `voice.*` is left out of the MCP endpoint and the worker relay, `/api/voice/transcribe` is not a relayed route, and the route refuses a request carrying an agent's chat or worktree header.
- The worker method that makes the call (`speech.transcribe`) answers only on the hub's link. It is not a direct-path procedure, and an agent cannot reach it. The URL it calls comes from the hub's settings on every request, never from a client.

## Troubleshooting

**No mic in the composer.** Voice is off or incomplete in Settings > Voice, or the page cannot record. Browsers expose the microphone only to secure pages: `https://`, `http://localhost` or `http://127.0.0.1`. A hub opened over plain `http://` on a LAN address shows no mic. Use the desktop app, an HTTPS address (a tunnel or a reverse proxy) or the Expo app.

**"Microphone access is blocked".** The browser or the system refused the microphone. In a browser, allow it from the lock icon in the address bar. In the desktop app, allow Band in System Settings > Privacy & Security > Microphone. In the Expo app, turn it on in Settings > Band > Microphone. Then tap the mic again.

**"Could not reach host:port".** The base URL is wrong or the server is not running. For a local server, check that the Run on host is the machine where the server listens on `127.0.0.1`.

**"The speech-to-text server refused the API key".** Pick the right key, or check it at the provider.

**"The server did not return a transcription".** The base URL probably lacks `/v1`, or the model is not a speech-to-text model.

**"The speech-to-text server answered 404/400 ...".** Usually an unknown model name. The server's message is shown with any key removed.

**Nothing appears after recording.** "No speech was recognized" means the provider returned empty text. Check the language setting and the microphone level.

**iPhone Safari.** `MediaRecorder` with mp4 works on current iOS Safari. If your iOS version cannot record, the mic stays hidden.

## Not included

Streaming partial text, OpenAI's Realtime API, voice activity detection with auto-stop, hold-to-talk, global shortcuts, dictation into terminals, text to speech, and per-device endpoints. There is one hub-wide endpoint.
