/**
 * Dollar amounts in an agent reply stay plain text, and real math renders once.
 *
 * `$100 a month and Ultra gets $200` used to parse as one inline formula
 * (remark-math only checks whitespace next to the dollar signs), and the
 * missing KaTeX stylesheet showed every formula twice (MathML plus HTML).
 *
 * The real server runs against the scripted ACP stub agent, which replies
 * with the text of the matching turn.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { acpStubEnv } from "./helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChatPanePage } from "./pages/ChatPanePage";

const TOKEN = "e2e-chat-dollar-math-token";
const REPO = "dollarmath";
const WORKTREE = toWorktreeId(REPO, "main", "local");

const PRICES =
  "Max gets $100 a month and Ultra gets $200 (Ultra costs $5 and $10, or $1,000 to $2,000)";
const SUFFIX =
  "Stariju cenu Bitwarden Premiuma od 10 $. Od januara 2026. on košta 19,80 $. Putanja je $PATH/$HOME.";
const MATH = "Inline $x^2$ and block $$\\int_0^1 x\\,dx$$ done";

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoDir = join(tmpHome, "repo");
  mkdirSync(repoDir, { recursive: true });
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repoDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoDir }],
      },
    ],
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      turns: [
        { match: "prices", steps: [{ say: PRICES }] },
        { match: "math", steps: [{ say: MATH }] },
        { match: "suffix", steps: [{ say: SUFFIX }] },
      ],
    }),
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("dollar amounts render as literal text, not math", async ({ page }) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  await chatPane.goto(WORKTREE);
  await chatPane.waitForReady();
  await chatPane.promptInput.fill("prices");
  await chatPane.submit();

  const reply = chatPane.assistantMessage("Max gets");
  await expect(reply).toBeVisible();
  await expect(reply).toContainText(PRICES);
  await expect(chatPane.assistantFormulas("Max gets")).toHaveCount(0);
  await expect(chatPane.thinkingIndicator).toBeHidden();
});

test("suffix currency and shell variables render as literal text", async ({ page }) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  await chatPane.goto(WORKTREE);
  await chatPane.waitForReady();
  await chatPane.promptInput.fill("suffix");
  await chatPane.submit();

  const reply = chatPane.assistantMessage("Stariju cenu");
  await expect(reply).toBeVisible();
  await expect(reply).toContainText(SUFFIX);
  await expect(chatPane.assistantFormulas("Stariju cenu")).toHaveCount(0);
  await expect(chatPane.thinkingIndicator).toBeHidden();
});

test("real math renders once, with the MathML copy hidden", async ({ page }) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  await chatPane.goto(WORKTREE);
  await chatPane.waitForReady();
  await chatPane.promptInput.fill("math");
  await chatPane.submit();

  await expect(chatPane.assistantFormulas("Inline")).toHaveCount(2);
  // The visible text holds three x (x squared, x, and the x of dx). Without
  // katex.css the MathML copy is visible too and the count doubles to six.
  await expect
    .poll(async () => (await chatPane.assistantVisibleText("Inline")).match(/x/g)?.length ?? 0)
    .toBe(3);
  await expect(chatPane.thinkingIndicator).toBeHidden();
});
