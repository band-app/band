---
paths:
  - "**/VoiceSettings.tsx"
  - "**/components/ai-elements/prompt-input-mic.tsx"
  - "**/electron-builder.yml"
  - "**/fixtures/stt-stub.ts"
  - "**/lib/composer/dictation.ts"
  - "**/lib/voice-recorder.ts"
  - "**/use-dictation.ts"
  - "apps/desktop/tests/microphone-config.test.ts"
  - "apps/hub/src/server/api/voice/handler.ts"
  - "apps/hub/src/server/services/voice-service.ts"
  - "apps/hub/tests/voice.test.ts"
  - "apps/mobile/tests/dictation.test.ts"
  - "apps/web/e2e/voice-dictation.spec.ts"
  - "apps/worker/src/methods-basic.ts"
  - "apps/worker/tests/speech.test.ts"
  - "docs/voice-dictation.md"
  - "packages/shared/src/speech-transcription.ts"
---

# Architecture: voice dictation

The composer's mic sends a recording to the hub, and the hub calls one hub-wide OpenAI-compatible speech-to-text endpoint (guide: `docs/voice-dictation.md`). Band downloads and runs no models.

- Call path. A client posts the clip to `POST /api/voice/transcribe` (`api/voice/handler.ts`, after the device-token check, raw body, `Content-Type` is the clip's MIME type, 25 MB cap) and gets `{ text }` or `{ error: { code, message } }`. `services/voice-service.ts` reads `settings.voice` (`enabled`, `baseUrl`, `model`, `language`, `hostId`, `apiKeyItemId`), reads the key from the vault (`vaultService.getCredential`), and either calls `requestTranscription` itself or, with `hostId` set, calls `host.speech.transcribe` so that worker's worker makes the request from its own network. A server on a Mac's `127.0.0.1` is reached that way from a hub elsewhere. An offline worker answers `host_offline` and nothing falls back to the hub.
- The request builder is `packages/shared/src/speech-transcription.ts`: multipart `file`, `model`, `response_format=json` (mlx-audio defaults to `ndjson`) and optional `language`, a `.webm`/`.m4a` file name and part type read from the clip's first bytes (`detectAudioType`, the request's MIME type only when the bytes match nothing), a 2 minute timeout, no redirects, and a `SpeechError` code per failure. Messages never hold the key (`scrubSecrets` also strips echoes of it from provider bodies). The hub and `LocalHost.speech` both use it.
- Worker. `speech.transcribe` (`apps/worker/src/methods-basic.ts`) takes the clip as `{ base64 }` up to 256 KB and as a link channel above that, and the URL, model and key from the hub on every call. It is not in `DIRECT_PROCEDURES`, so the direct listener answers 404. Only the hub's link reaches it, and it returns a provider failure as a coded result so the code survives the link.
- Access. `voice.status` is readable by every device (a boolean and a reason, no URL). `voice.config` and `voice.test` are admin only, and `settings.update` with `voice` needs an admin token. `voice.*` is left out of the MCP endpoint and the relay, `/api/voice/transcribe` is not a relayed route, and it answers 403 to a request carrying `x-band-chat-id`, `x-band-worktree-id` or `x-band-terminal-id`.
- Clients. Web: `PromptInputMic` (`components/ai-elements/prompt-input-mic.tsx`, `lib/voice-recorder.ts`), shown only when `voice.status` says available and the browser can record (`getUserMedia` needs a secure context). Settings > Voice is `VoiceSettings.tsx`. Mobile: `lib/composer/dictation.ts` (state machine over a recorder port, upload) and `use-dictation.ts` (`expo-audio`). Desktop: the `com.apple.security.device.audio-input` entitlement and `NSMicrophoneUsageDescription` in `electron-builder.yml`. Electron has no permission handler that blocks media.
- Tests: `apps/hub/tests/voice.test.ts` (real hub, real worker, `fixtures/stt-stub.ts`), `apps/worker/tests/speech.test.ts`, `apps/web/e2e/voice-dictation.spec.ts` (Chromium fake microphone), `apps/mobile/tests/dictation.test.ts` (fake recorder port, real HTTP server), `apps/desktop/tests/microphone-config.test.ts` (reads the packaging config, because a TCC prompt cannot be automated).
- Not done yet: streaming partials, Realtime, auto-stop on silence, dictation into terminals, per-device endpoints.
