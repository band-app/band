// Express stub for an OpenAI-compatible speech-to-text server (`POST /v1/audio/transcriptions`).
// It records the multipart fields and the Bearer header of every request, and answers by the key:
// the one in `key` gets `text`, any other gets a 401 whose body echoes the key it was sent, so a
// test can check the hub never repeats it. A model named `missing-model` gets a 404 that echoes
// the key too.

import type { Server } from "node:http";
import express from "express";

export interface SttRequest {
  path: string;
  auth: string | undefined;
  model: string | null;
  responseFormat: string | null;
  language: string | null;
  fileName: string | null;
  fileType: string | null;
  fileSize: number;
}

export interface SttStub {
  /** `http://127.0.0.1:<port>/v1` */
  baseUrl: string;
  requests: SttRequest[];
  close: () => Promise<void>;
}

export async function startSttStub(opts: { key?: string; text?: string } = {}): Promise<SttStub> {
  const key = opts.key;
  const text = opts.text ?? "Fix the login bug";
  const requests: SttRequest[] = [];
  const app = express();
  app.post(
    "/v1/audio/transcriptions",
    express.raw({ type: () => true, limit: "30mb" }),
    async (req, res) => {
      const form = await new Request("http://stub.local/", {
        method: "POST",
        headers: { "content-type": req.headers["content-type"] ?? "" },
        body: req.body as Buffer,
      }).formData();
      const file = form.get("file") as File | null;
      const seen: SttRequest = {
        path: req.path,
        auth: req.headers.authorization,
        model: form.get("model") as string | null,
        responseFormat: form.get("response_format") as string | null,
        language: form.get("language") as string | null,
        fileName: file?.name ?? null,
        fileType: file?.type ?? null,
        fileSize: file?.size ?? 0,
      };
      requests.push(seen);
      const sent = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (key !== undefined && sent !== key) {
        res.status(401).json({ error: { message: `Incorrect API key provided: ${sent}` } });
        return;
      }
      if (seen.model === "missing-model") {
        res
          .status(404)
          .json({ error: { message: `model missing-model not found for key ${sent}` } });
        return;
      }
      res.json({ text });
    },
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
