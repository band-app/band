// Express stub for Contabo's auth server and API. The `contabo` runner hook calls it through
// `CONTABO_AUTH_URL` and `CONTABO_API_URL`, which the hook reads on every call.

import type { Server } from "node:http";
import express from "express";

export interface StubInstance {
  instanceId: number;
  displayName: string;
  status: string;
  imageId: string;
  userData: string | null;
  cancelDate?: string;
}

export interface ContaboCredentials {
  clientId: string;
  clientSecret: string;
  user: string;
  password: string;
}

export interface ContaboStub {
  url: string;
  instances: StubInstance[];
  /** Form fields of every token request, in order. */
  tokenRequests: Array<Record<string, string>>;
  /** `METHOD path` of every API call, in order. */
  requests: string[];
  /** Move every instance that is installing or provisioning to running, as Contabo does when the install ends. */
  finishInstalls: () => void;
  close: () => Promise<void>;
}

export async function startContaboStub(
  creds: ContaboCredentials,
  initial: Array<Pick<StubInstance, "instanceId" | "displayName">>,
): Promise<ContaboStub> {
  const instances: StubInstance[] = initial.map((i) => ({
    ...i,
    status: "running",
    imageId: "image-original",
    userData: null,
  }));
  const tokenRequests: Array<Record<string, string>> = [];
  const requests: string[] = [];
  const accessToken = "contabo-access-token";
  let nextId = 900;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.post("/auth/token", (req, res) => {
    const form = req.body as Record<string, string>;
    tokenRequests.push(form);
    const ok =
      form.grant_type === "password" &&
      form.client_id === creds.clientId &&
      form.client_secret === creds.clientSecret &&
      form.username === creds.user &&
      form.password === creds.password;
    if (!ok) {
      res
        .status(401)
        .json({ error: "invalid_grant", error_description: "Invalid user credentials" });
      return;
    }
    res.json({ access_token: accessToken, token_type: "Bearer", expires_in: 300 });
  });

  const api = express.Router();
  api.use((req, res, next) => {
    requests.push(`${req.method} ${req.path}`);
    if (req.headers.authorization !== `Bearer ${accessToken}` || !req.headers["x-request-id"]) {
      res.status(401).json({ message: "missing token or x-request-id" });
      return;
    }
    next();
  });
  api.get("/compute/instances", (req, res) => {
    const prefix = String(req.query.displayName ?? "");
    res.json({ data: instances.filter((i) => i.displayName.startsWith(prefix)) });
  });
  api.get("/compute/instances/:id", (req, res) => {
    const found = instances.find((i) => String(i.instanceId) === req.params.id);
    if (!found) res.status(404).json({ message: "instance not found" });
    else res.json({ data: [found] });
  });
  api.post("/compute/instances", (req, res) => {
    const body = req.body as Record<string, string>;
    const created: StubInstance = {
      instanceId: nextId++,
      displayName: body.displayName,
      status: "provisioning",
      imageId: body.imageId,
      userData: body.userData,
    };
    instances.push(created);
    res.status(201).json({
      data: [{ ...created, productId: body.productId, region: body.region, period: body.period }],
    });
  });
  api.patch("/compute/instances/:id", (req, res) => {
    const found = instances.find((i) => String(i.instanceId) === req.params.id);
    if (!found) {
      res.status(404).json({ message: "instance not found" });
      return;
    }
    found.displayName = (req.body as { displayName: string }).displayName;
    res.json({ data: [found] });
  });
  api.put("/compute/instances/:id", (req, res) => {
    const found = instances.find((i) => String(i.instanceId) === req.params.id);
    if (!found) {
      res.status(404).json({ message: "instance not found" });
      return;
    }
    const body = req.body as { imageId: string; userData?: string };
    found.imageId = body.imageId;
    found.userData = body.userData ?? null;
    found.status = "installing";
    res.json({ data: [found] });
  });
  api.post("/compute/instances/:id/cancel", (req, res) => {
    const found = instances.find((i) => String(i.instanceId) === req.params.id);
    if (!found) {
      res.status(404).json({ message: "instance not found" });
      return;
    }
    found.cancelDate = "2099-01-01";
    res.json({ data: [{ instanceId: found.instanceId, cancelDate: found.cancelDate }] });
  });
  app.use("/v1", api);

  const http: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("contabo stub has no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    instances,
    tokenRequests,
    requests,
    finishInstalls: () => {
      for (const i of instances)
        if (i.status === "installing" || i.status === "provisioning") i.status = "running";
    },
    close: () => new Promise((resolve) => http.close(() => resolve())),
  };
}
