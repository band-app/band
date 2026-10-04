import { basename, dirname, isAbsolute } from "node:path";
import {
  type Environment,
  type EnvironmentIssue,
  type UnmetRequirement,
  unmetRequirements,
} from "@band-app/environment";
import { TRPCError } from "@trpc/server";
import { hostRegistry } from "../infra/host/registry";
import { projectService } from "./project-service";
import { MAX_LIST_LIMIT, tokenService } from "./token-service";

/** A host and whether its tools meet a project's `requires`. */
export interface HostFit {
  id: string;
  name: string;
  status: string;
  /** Toolchain versions the host reported. */
  tools: Record<string, string>;
  /** True when `unmet` is empty. */
  meets: boolean;
  unmet: UnmetRequirement[];
}

export interface EnvironmentView {
  /** The `.band/environment.json` that was read, or `null` when there is none. */
  source: string | null;
  environment: Environment | null;
  issues: EnvironmentIssue[];
}

export interface ProjectEnvironmentView extends EnvironmentView {
  /** Every host with whether it meets the file's `requires`. Empty when the file does not parse. */
  hosts: HostFit[];
}

/**
 * `.band/environment.json` for the dashboard and the CLI. The file is read on
 * the hub's own machine, from a project's main checkout or from a path the
 * caller names. A workspace reads its own copy through its host when it sets
 * up (see `HostScripts.environment`).
 */
export class EnvironmentService {
  /** The environment of a project's main checkout, and which hosts meet its `requires`. */
  async forProject(projectName: string): Promise<ProjectEnvironmentView | null> {
    const path = projectService.findPath(projectName);
    if (path === undefined) return null;
    const view = await this.read(path);
    return { ...view, hosts: view.environment ? await this.hostsFor(view.environment) : [] };
  }

  /**
   * Validates the environment of the repository at `path`, which may also
   * name the `.band/environment.json` file itself.
   */
  async validatePath(path: string): Promise<EnvironmentView> {
    if (!isAbsolute(path)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "path must be absolute" });
    }
    const isFile = basename(path) === "environment.json" && basename(dirname(path)) === ".band";
    return this.read(isFile ? dirname(dirname(path)) : path);
  }

  private read(dir: string): Promise<EnvironmentView> {
    return hostRegistry.local.scripts.environment({ projectPath: dir, worktreePath: dir });
  }

  private async hostsFor(environment: Environment): Promise<HostFit[]> {
    const local = await hostRegistry.local.info().catch(() => null);
    return tokenService
      .listHosts(MAX_LIST_LIMIT)
      .filter((h) => h.status !== "disposed" && h.usable)
      .map((h) => {
        const tools = h.id === "local" && local ? local.tools : h.tools;
        const unmet = unmetRequirements(environment.requires, tools);
        return {
          id: h.id,
          name: h.name,
          status: h.status,
          tools,
          meets: unmet.length === 0,
          unmet,
        };
      });
  }
}

export const environmentService = new EnvironmentService();
