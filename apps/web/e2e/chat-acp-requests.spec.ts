/**
 * The chat pane's answers to ACP agent requests, end to end (issue #648).
 *
 *   - A `session/request_permission` renders as a permission card with one
 *     button per option the agent offered. Clicking one answers the request,
 *     marks the card answered, and the agent continues on that branch.
 *   - A form `elicitation/create` (Claude Code's AskUserQuestion) renders as
 *     a form. Picking a choice and submitting sends the values back, and the
 *     agent's reply shows what it received.
 *   - The model picker is built from the session's `model` config option.
 *     Choosing another model sends `session/set_config_option`, and the next
 *     turn runs on that model.
 *
 * Real server, no tRPC mocking. The ACP stub agent
 * (`apps/web/tests/fixtures/acp-stub-agent.mjs`) is the only stub: its
 * scenario scripts the requests, and its default reply names the session's
 * current model (`Heard "<prompt>" on <model>.`). Each test opens its own
 * workspace so it gets a fresh chat.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { acpStubEnv, stubRequests } from "./helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChatPanePage } from "./pages/ChatPanePage";

const TOKEN = "e2e-chat-acp-requests-token";
const PROJECTS = ["acppermission", "acpelicit", "acpmodel"] as const;

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const projects = PROJECTS.map((name) => {
    const repoDir = join(tmpHome, name);
    mkdirSync(repoDir, { recursive: true });
    return {
      name,
      path: repoDir,
      defaultBranch: "main",
      worktrees: [{ branch: "main", path: repoDir }],
    };
  });
  seedState(tmpHome, { projects });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    defaultCodingAgent: "claude-code",
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });

  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      turns: [
        {
          match: "^deploy",
          steps: [
            {
              permission: {
                toolCall: {
                  toolCallId: "tc-deploy",
                  title: "Deploy to prod",
                  kind: "execute",
                  status: "pending",
                },
                options: [
                  { optionId: "allow", name: "Allow", kind: "allow_once" },
                  { optionId: "reject", name: "Reject", kind: "reject_once" },
                ],
              },
              after: {
                allow: [{ say: "Deployed." }],
                reject: [{ say: "Not deployed." }],
              },
            },
          ],
        },
        {
          match: "^ask me",
          steps: [
            {
              elicitation: {
                message: "Which color should the button be?",
                requestedSchema: {
                  type: "object",
                  properties: {
                    color: {
                      type: "string",
                      title: "Color",
                      oneOf: [
                        { const: "red", title: "Red" },
                        { const: "blue", title: "Blue" },
                      ],
                    },
                  },
                  required: ["color"],
                },
              },
              // No `after`: the stub replies `Answer: <JSON of the values>`.
            },
          ],
        },
        // Anything else gets the stub's default reply, which names the model.
      ],
    }),
  });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Chat pane — ACP agent requests", () => {
  test("a permission card answers with the picked option and the agent continues on that branch", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("acppermission", "main"));
    await chatPane.waitForReady();

    await chatPane.typeMessage("deploy please");
    await chatPane.submit();
    await expect(chatPane.permissionCards).toHaveCount(1);
    await expect(chatPane.permissionCards.nth(0)).toHaveAttribute("data-answered", "false");

    await chatPane.answerPermission(0, "Allow");
    await expect(chatPane.assistantMessage("Deployed.")).toBeVisible();
    await expect(chatPane.permissionCards.nth(0)).toHaveAttribute("data-answered", "true");

    // A second request in the same chat, answered the other way.
    await chatPane.typeMessage("deploy again");
    await chatPane.submit();
    await expect(chatPane.permissionCards).toHaveCount(2);
    await chatPane.answerPermission(1, "Reject");
    await expect(chatPane.assistantMessage("Not deployed.")).toBeVisible();
    await expect(chatPane.permissionCards.nth(1)).toHaveAttribute("data-answered", "true");
  });

  test("an elicitation form sends the picked choice back to the agent", async ({ page }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("acpelicit", "main"));
    await chatPane.waitForReady();

    await chatPane.typeMessage("ask me something");
    await chatPane.submit();
    await expect(chatPane.elicitationForms).toHaveCount(1);
    await expect(chatPane.elicitationForms.nth(0)).toHaveAttribute("data-answered", "false");

    await chatPane.pickElicitationChoice(0, "Blue");
    await chatPane.submitElicitation(0);

    // The stub echoes the values it received.
    await expect(chatPane.assistantMessage('Answer: {"color":"blue"}')).toBeVisible();
    await expect(chatPane.elicitationForms.nth(0)).toHaveAttribute("data-answered", "true");
  });

  test("choosing another model in the model menu runs the next turn on that model", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("acpmodel", "main"));
    await chatPane.waitForReady();

    await chatPane.typeMessage("first");
    await chatPane.submit();
    await expect(chatPane.assistantMessage('Heard "first" on stub-small.')).toBeVisible();

    await chatPane.selectModel("Stub Large");
    // The trigger shows the chosen model once the agent confirms it.
    await expect(chatPane.modelMenuButton).toHaveText(/Stub Large/);

    await chatPane.typeMessage("second");
    await chatPane.submit();
    await expect(chatPane.assistantMessage('Heard "second" on stub-large.')).toBeVisible();

    // Band changed the model over ACP, not by starting a new session.
    const setOption = stubRequests(tmpHome, "session/set_config_option").map((r) => r.params);
    expect(setOption).toEqual([
      expect.objectContaining({ configId: "model", value: "stub-large" }),
    ]);
  });
});
