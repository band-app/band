import net from "net";
import { spawn } from "child_process";

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: "localhost" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      resolve(true);
    });
  });
}

async function findAvailablePort(startPort) {
  let port = startPort;
  while (!(await isPortAvailable(port))) {
    port++;
  }
  return port;
}

const port = await findAvailablePort(1420);
console.log(`Using port ${port} for dev server`);

const configOverride = JSON.stringify({
  build: {
    devUrl: `http://localhost:${port}`,
  },
});

const child = spawn("npx", ["tauri", "dev", "--config", configOverride], {
  stdio: "inherit",
  env: { ...process.env, VITE_PORT: String(port) },
});

child.on("exit", (code) => process.exit(code ?? 1));
