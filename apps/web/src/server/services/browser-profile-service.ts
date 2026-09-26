/**
 * Band browser profiles and the per-project default profile.
 *
 * A profile is an isolated cookie/storage jar for browser tabs. The desktop
 * app maps each profile id to its own Electron session partition; this
 * service only keeps the metadata and remembers which profile each project
 * uses, so a new browser tab in any workspace of that project opens in it.
 *
 * The built-in Default profile has the id `null` everywhere (no row, the
 * desktop's original `persist:band-browser` partition).
 */

import { createLogger } from "@band-app/logger";
import { toWorkspaceId } from "@/dashboard";
import { BrowserProfileNotFoundError } from "../errors";
import {
  BrowserProfileQueries,
  type BrowserProfileRow,
} from "../infra/db/queries/browser-profiles";
import { browserService } from "./browser-service";
import { loadState } from "./state";

const log = createLogger("browser-profile-service");

export type BrowserProfile = BrowserProfileRow;

/**
 * Profile ids become part of an Electron partition name on the desktop, so
 * they are restricted to a filesystem- and partition-safe alphabet.
 */
export const BROWSER_PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class BrowserProfileService {
  constructor(private readonly queries: BrowserProfileQueries = new BrowserProfileQueries()) {}

  list(): BrowserProfile[] {
    return this.queries.findAll();
  }

  get(id: string): BrowserProfile | undefined {
    return this.queries.find(id);
  }

  create(input: { id?: string; name: string; source?: string | null }): BrowserProfile {
    const profile: BrowserProfile = {
      id: input.id ?? `profile_${crypto.randomUUID()}`,
      name: input.name,
      source: input.source ?? null,
      createdAt: Date.now(),
    };
    this.queries.insert(profile);
    log.info({ profileId: profile.id, source: profile.source }, "browser profile created");
    return profile;
  }

  rename(id: string, name: string): BrowserProfile {
    this.requireProfile(id);
    this.queries.rename(id, name);
    return this.requireProfile(id);
  }

  /**
   * Delete a profile. Projects that defaulted to it fall back to Default,
   * and so do open tabs that used it.
   */
  remove(id: string): void {
    this.requireProfile(id);
    this.queries.remove(id);
    browserService.clearProfile(id);
    log.info({ profileId: id }, "browser profile removed");
  }

  /** The profile new tabs in `projectName` open with. `null` is Default. */
  getProjectDefault(projectName: string): string | null {
    const profileId = this.queries.getProjectDefault(projectName);
    // A dangling mapping (profile row gone) reads as Default.
    if (profileId && !this.queries.find(profileId)) return null;
    return profileId;
  }

  setProjectDefault(projectName: string, profileId: string | null): void {
    if (profileId === null) {
      this.queries.clearProjectDefault(projectName);
      return;
    }
    this.requireProfile(profileId);
    this.queries.setProjectDefault(projectName, profileId, Date.now());
  }

  /** Drop the project's mapping. Called when the project is removed. */
  forgetProject(projectName: string): void {
    this.queries.clearProjectDefault(projectName);
  }

  /** Every project that has a default profile set. */
  listProjectDefaults(): { projectName: string; profileId: string }[] {
    return this.queries.findAllProjectDefaults();
  }

  /** The profile a new browser tab in `workspaceId` should open with. */
  defaultForWorkspace(workspaceId: string): string | null {
    const projectName = projectNameForWorkspace(workspaceId);
    return projectName ? this.getProjectDefault(projectName) : null;
  }

  /**
   * Switch a tab to `profileId` and make that the default for the tab's
   * project, so the next tab in any workspace of the project opens in it.
   */
  setTabProfile(browserId: string, profileId: string | null) {
    if (profileId !== null) this.requireProfile(profileId);
    const tab = browserService.setProfile(browserId, profileId);
    if (!tab) return undefined;
    const projectName = projectNameForWorkspace(tab.workspaceId);
    if (projectName) this.setProjectDefault(projectName, profileId);
    return tab;
  }

  /** Throws `BrowserProfileNotFoundError` for an unknown id. */
  requireProfile(id: string): BrowserProfile {
    const profile = this.queries.find(id);
    if (!profile) throw new BrowserProfileNotFoundError(id);
    return profile;
  }
}

function projectNameForWorkspace(workspaceId: string): string | null {
  for (const project of loadState().projects) {
    for (const wt of project.worktrees) {
      if (toWorkspaceId(project.name, wt.name) === workspaceId) return project.name;
    }
  }
  return null;
}

export const browserProfileService = new BrowserProfileService();
