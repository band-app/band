// Express stub for the Hetzner Cloud API. The `hetzner` runner hook calls it through `HCLOUD_API_URL`,
// which the hook reads on every call. It keeps servers in memory and records each request.

import type { Server } from "node:http";
import express from "express";

export interface StubServer {
  id: number;
  name: string;
  status: string;
  labels: Record<string, string>;
  server_type: string;
  image: string;
  location: string;
  user_data: string;
  ssh_keys?: unknown[];
}

export interface StubImage {
  id: number;
  type: "snapshot";
  description: string;
  labels: Record<string, string>;
  /** The server it was taken from. */
  created_from: number;
  image_size: number | null;
}

export interface HetznerStub {
  url: string;
  servers: StubServer[];
  images: StubImage[];
  /** Polls of an image action that answer `running` before it succeeds. Set before calling `snapshot`. */
  actionPolls: { running: number; fail: boolean };
  /** `METHOD path` and the Authorization header of every call, in order. */
  requests: Array<{ line: string; authorization: string | undefined }>;
  close: () => Promise<void>;
}

export async function startHetznerStub(token: string): Promise<HetznerStub> {
  const servers: StubServer[] = [];
  const images: StubImage[] = [];
  const actionPolls = { running: 0, fail: false };
  /** Remaining `running` answers per action id. */
  const pending = new Map<number, number>();
  let nextImageId = 9100;
  let nextActionId = 5000;
  const requests: HetznerStub["requests"] = [];
  let nextId = 4200;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    requests.push({ line: `${req.method} ${req.path}`, authorization: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.status(401).json({ error: { code: "unauthorized", message: "unable to authenticate" } });
      return;
    }
    next();
  });
  app.get("/servers", (req, res) => {
    const selector = String(req.query.label_selector ?? "");
    const [key, value] = selector.split("=");
    const matched = servers.filter((s) =>
      value === undefined ? key in s.labels : s.labels[key] === value,
    );
    res.json({ servers: matched, meta: { pagination: { next_page: null } } });
  });
  app.post("/servers", (req, res) => {
    const body = req.body as Partial<StubServer>;
    const server: StubServer = {
      id: nextId++,
      name: String(body.name),
      status: "initializing",
      labels: body.labels ?? {},
      server_type: String(body.server_type),
      image: String(body.image),
      location: String(body.location),
      user_data: String(body.user_data),
      ssh_keys: body.ssh_keys,
    };
    servers.push(server);
    res.status(201).json({ server, root_password: null });
  });
  app.delete("/servers/:id", (req, res) => {
    const index = servers.findIndex((s) => String(s.id) === req.params.id);
    if (index < 0) {
      res.status(404).json({ error: { code: "not_found", message: "server not found" } });
      return;
    }
    servers.splice(index, 1);
    res.json({ action: { id: 1, status: "running" } });
  });

  app.post("/servers/:id/actions/create_image", (req, res) => {
    const server = servers.find((x) => String(x.id) === req.params.id);
    if (!server) {
      res.status(404).json({ error: { code: "not_found", message: "server not found" } });
      return;
    }
    const body = req.body as Partial<StubImage>;
    const image: StubImage = {
      id: nextImageId++,
      type: "snapshot",
      description: String(body.description ?? ""),
      labels: body.labels ?? {},
      created_from: server.id,
      image_size: 2.5,
    };
    images.push(image);
    const id = nextActionId++;
    pending.set(id, actionPolls.running);
    res.status(201).json({ image, action: { id, status: "running" } });
  });
  app.get("/actions/:id", (req, res) => {
    const id = Number(req.params.id);
    const left = pending.get(id);
    if (left === undefined) {
      res.status(404).json({ error: { code: "not_found", message: "action not found" } });
      return;
    }
    if (left > 0) {
      pending.set(id, left - 1);
      res.json({ action: { id, status: "running" } });
      return;
    }
    res.json({
      action: actionPolls.fail
        ? { id, status: "error", error: { code: "action_failed", message: "snapshot failed" } }
        : { id, status: "success" },
    });
  });
  app.get("/images/:id", (req, res) => {
    const image = images.find((i) => String(i.id) === req.params.id);
    if (!image) {
      res.status(404).json({ error: { code: "not_found", message: "image not found" } });
      return;
    }
    res.json({ image });
  });
  app.delete("/images/:id", (req, res) => {
    const index = images.findIndex((i) => String(i.id) === req.params.id);
    if (index < 0) {
      res.status(404).json({ error: { code: "not_found", message: "image not found" } });
      return;
    }
    images.splice(index, 1);
    res.status(204).end();
  });

  const http: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("hetzner stub has no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    servers,
    images,
    actionPolls,
    requests,
    close: () => new Promise((resolve) => http.close(() => resolve())),
  };
}
