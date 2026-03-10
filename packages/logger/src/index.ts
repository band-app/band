import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(name: string): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL || "info",
  });
}
