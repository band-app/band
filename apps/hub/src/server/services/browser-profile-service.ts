/**
 * Band browser profiles and the per-repo default profile.
 *
 * A profile is an isolated cookie/storage jar for browser tabs. The desktop
 * app maps each profile id to its own Electron session partition; this
 * service only keeps the metadata and remembers which profile each repo
 * uses, so a new browser tab in any worktree of that repo opens in it.
 *
 * The built-in Default profile has the id `null` everywhere (no row, the
 * desktop's original `persist:band-browser` partition).
 */

import { createLogger } from "@band-app/logger";
import { BrowserProfileExistsError, BrowserProfileNotFoundError } from "../errors";
import {
  BrowserProfileQueries,
  type BrowserProfileRow,
} from "../infra/db/queries/browser-profiles";
import { WorktreeQueries } from "../infra/db/queries/worktrees";
import { type BrowserService, browserService } from "./browser-service";

const log = createLogger("browser-profile-service");

export type BrowserProfile = BrowserProfileRow;

/**
 * Profile ids become part of an Electron partition name on the desktop, so
 * they are restricted to a filesystem- and partition-safe alphabet.
 */
export const BROWSER_PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Two profile names clash when they match ignoring case and surrounding whitespace. */
function profileNameKey(name: string): string {
  return name.trim().toLowerCase();
}

export class BrowserProfileService {
  constructor(
    private readonly queries: BrowserProfileQueries = new BrowserProfileQueries(),
    private readonly browsers: BrowserService = browserService,
    private readonly worktrees: WorktreeQueries = new WorktreeQueries(),
  ) {}

  list(): BrowserProfile[] {
    return this.queries.findAll();
  }

  get(id: string): BrowserProfile | undefined {
    return this.queries.find(id);
  }

  /**
   * Throws `BrowserProfileExistsError` when `input.id` is taken, or when
   * another profile has the same name, ignoring case.
   */
  create(input: { id?: string; name: string; source?: string | null }): BrowserProfile {
    if (input.id && this.queries.find(input.id)) {
      throw new BrowserProfileExistsError(`Browser profile already exists: ${input.id}`);
    }
    const key = profileNameKey(input.name);
    if (this.queries.findAll().some((p) => profileNameKey(p.name) === key)) {
      throw new BrowserProfileExistsError(`A browser profile named "${input.name}" already exists`);
    }
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

  /**
   * Delete a profile. Repos that defaulted to it fall back to Default,
   * and so do open tabs that used it.
   */
  remove(id: string): void {
    this.requireProfile(id);
    this.queries.remove(id);
    this.browsers.clearProfile(id);
    log.info({ profileId: id }, "browser profile removed");
  }

  /** The profile new tabs in `repoName` open with. `null` is Default. */
  getRepoDefault(repoName: string): string | null {
    const profileId = this.queries.getRepoDefault(repoName);
    // A dangling mapping (profile row gone) reads as Default.
    if (profileId && !this.queries.find(profileId)) return null;
    return profileId;
  }

  setRepoDefault(repoName: string, profileId: string | null): void {
    if (profileId === null) {
      this.queries.clearRepoDefault(repoName);
      return;
    }
    this.requireProfile(profileId);
    this.queries.setRepoDefault(repoName, profileId, Date.now());
  }

  /** Drop the repo's mapping. Called when the repo is removed. */
  forgetRepo(repoName: string): void {
    this.queries.clearRepoDefault(repoName);
  }

  /** Every repo that has a default profile set. */
  listRepoDefaults(): { repoName: string; profileId: string }[] {
    return this.queries.findAllRepoDefaults();
  }

  /**
   * The profile a new browser tab in `worktreeId` opens with. `requested`
   * is what the caller asked for: `undefined` means "the repo's
   * default", `null` means Default, and an id must exist.
   */
  resolveForNewTab(worktreeId: string, requested: string | null | undefined): string | null {
    if (requested === undefined) {
      const repoName = this.repoNameForWorktree(worktreeId);
      return repoName ? this.getRepoDefault(repoName) : null;
    }
    if (requested !== null) this.requireProfile(requested);
    return requested;
  }

  /**
   * Switch a tab to `profileId` and make that the default for the tab's
   * repo, so the next tab in any worktree of the repo opens in it.
   */
  setTabProfile(browserId: string, profileId: string | null) {
    if (profileId !== null) this.requireProfile(profileId);
    const tab = this.browsers.setProfile(browserId, profileId);
    if (!tab) return undefined;
    const repoName = this.repoNameForWorktree(tab.worktreeId);
    if (repoName) this.setRepoDefault(repoName, profileId);
    return tab;
  }

  /** Throws `BrowserProfileNotFoundError` for an unknown id. */
  requireProfile(id: string): BrowserProfile {
    const profile = this.queries.find(id);
    if (!profile) throw new BrowserProfileNotFoundError(id);
    return profile;
  }

  private repoNameForWorktree(worktreeId: string): string | null {
    return this.worktrees.findIdentity(worktreeId)?.repo ?? null;
  }
}

export const browserProfileService = new BrowserProfileService();
