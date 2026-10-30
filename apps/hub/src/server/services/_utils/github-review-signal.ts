import type { ReviewTarget } from "../../infra/subscriptions/github";
import { reviewSignalService } from "../review-signal-service";

/** Tell open Checks panels that a GitHub pull request or branch changed. `repo` is `owner/name`. */
export function signalGithubReview(target: ReviewTarget): void {
  const [owner, repo] = target.repo.split("/");
  if (!owner || !repo) return;
  reviewSignalService.changed({
    repo: { host: "github.com", owner, repo },
    ...(target.branch && { branch: target.branch }),
    ...(target.number && { number: target.number }),
  });
}
