export type WorkerInstallTab = "service" | "foreground" | "docker" | "compose";

export const WORKER_INSTALL_TABS: { id: WorkerInstallTab; label: string; hint: string }[] = [
  {
    id: "service",
    label: "npm service",
    hint: "Linux and macOS. Installs @band-app/worker (Node 22.5 or newer), then registers it as a systemd user unit on Linux or a launchd agent on macOS, so it starts at login and restarts on failure.",
  },
  {
    id: "foreground",
    label: "npm foreground",
    hint: "Runs the worker in this terminal until you stop it. Needs @band-app/worker installed (npm install -g @band-app/worker).",
  },
  {
    id: "docker",
    label: "Docker run",
    hint: "Runs the published worker image. The volumes keep the worker's repositories and its identity across restarts.",
  },
  {
    id: "compose",
    label: "Docker compose",
    hint: "Save as compose.yml on the worker machine and run docker compose up -d.",
  },
];

export interface WorkerInstallInput {
  hubUrl: string;
  hostId: string;
  token: string;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A worker accepts plain http only for a loopback hub, which a container reaches through the host network. */
function isLoopbackHub(hubUrl: string): boolean {
  try {
    return LOOPBACK.has(new URL(hubUrl).hostname);
  } catch {
    return false;
  }
}

/** The command or file the user copies for one tab. The token is the one-time bootstrap token. */
export function workerInstallCommand(tab: WorkerInstallTab, input: WorkerInstallInput): string {
  const { hubUrl, hostId, token } = input;
  switch (tab) {
    case "service":
      return [
        "npm install -g @band-app/worker &&",
        `band-worker install-service --hub ${hubUrl} --worker-id ${hostId} --token ${token}`,
      ].join(" ");
    case "foreground":
      return [
        `BAND_HUB_URL=${hubUrl}`,
        `BAND_WORKER_ID=${hostId}`,
        `BAND_BOOTSTRAP_TOKEN=${token}`,
        "band-worker",
      ].join(" ");
    case "docker":
      return [
        "docker run -d --name band-worker --restart unless-stopped",
        ...(isLoopbackHub(hubUrl) ? ["--network host"] : []),
        "-v band-work:/work -v band-worker-state:/home/worker/.band/worker",
        `-e BAND_HUB_URL=${hubUrl} -e BAND_WORKER_ID=${hostId} -e BAND_WORKER_TOKEN=${token}`,
        "ghcr.io/band-app/band-worker:latest",
      ].join(" ");
    case "compose":
      return [
        "services:",
        "  band-worker:",
        "    image: ghcr.io/band-app/band-worker:latest",
        "    restart: unless-stopped",
        ...(isLoopbackHub(hubUrl) ? ["    network_mode: host"] : []),
        "    environment:",
        `      BAND_HUB_URL: ${hubUrl}`,
        `      BAND_WORKER_ID: ${hostId}`,
        `      BAND_WORKER_TOKEN: ${token}`,
        "    volumes:",
        "      - band-work:/work",
        "      - band-worker-state:/home/worker/.band/worker",
        "volumes:",
        "  band-work:",
        "  band-worker-state:",
        "",
      ].join("\n");
  }
}
