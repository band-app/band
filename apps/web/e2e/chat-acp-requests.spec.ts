/**
 * The chat pane's answers to ACP agent requests, end to end (issue #648).
 *
 *   - A `session/request_permission` renders as a permission card with one
 *     button per option the agent offered. Clicking one answers the request,
 *     marks the card answered, and the agent continues on that branch.
 *   - A form `elicitation/create` (Claude Code's AskUserQuestion) renders as
 *     a question card, one question at a time. Picking choices (by click or
 *     number key), moving on (Next / Enter), going Back and skipping (Esc)
 *     send the values back on the last question, and the agent's reply shows
 *     what it received. Skip all declines. The composer is disabled while
 *     the card waits.
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
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChatPanePage } from "./pages/ChatPanePage";

const TOKEN = "e2e-chat-acp-requests-token";
/** A label no agent ships with, so the question card's heading can only
 *  have taken it from settings. */
const AGENT_LABEL = "Stub Helper";
const PROJECTS = ["acppermission", "acpelicit", "acpquestions", "acpskipall", "acpmodel"] as const;

/** The form Claude Code's ACP adapter sends for an AskUserQuestion call with
 *  several questions: one `question_<n>` select per question (header as
 *  title, question as description) and a `question_<n>_custom` free-text box
 *  marked with `_askUserQuestionCustomAnswer`. */
function askUserQuestions(
  questions: { header: string; question: string; multi?: boolean; options: string[][] }[],
) {
  const properties: Record<string, unknown> = {};
  questions.forEach((q, i) => {
    const options = q.options.map(([title, description]) =>
      description ? { const: title, title, description } : { const: title, title },
    );
    properties[`question_${i}`] = q.multi
      ? { type: "array", title: q.header, description: q.question, items: { anyOf: options } }
      : { type: "string", title: q.header, description: q.question, oneOf: options };
    properties[`question_${i}_custom`] = {
      type: "string",
      title: "Other",
      _meta: {
        _askUserQuestionCustomAnswer: { questionId: `question_${i}`, isCustomAnswer: true },
      },
    };
  });
  return {
    message: "Please answer the following questions.",
    requestedSchema: { type: "object", properties },
  };
}

const THREE_QUESTIONS = askUserQuestions([
  {
    header: "Artikel",
    question: "___ Hund bellt.",
    options: [["Der", "masculine"], ["Die"], ["Das", "neuter"]],
  },
  {
    header: "Verb+Präp",
    question: "Which prepositions go with denken?",
    multi: true,
    options: [["an", "denken an: have on your mind"], ["über"], ["von"], ["auf"]],
  },
  {
    header: "Adjektiv",
    question: "ein ___ Tag",
    options: [["schöner"], ["schönes"]],
  },
]);

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
    codingAgents: [{ id: "claude-code", type: "claude-code", label: AGENT_LABEL }],
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
        {
          match: "^quiz me",
          // No `after`: the stub replies `Answer: <JSON of the values>`.
          steps: [{ elicitation: THREE_QUESTIONS }],
        },
        {
          match: "^skip me",
          steps: [{ elicitation: THREE_QUESTIONS, after: { decline: [{ say: "Skipped all." }] } }],
        },
        // Anything else gets the stub's default reply, which names the model.
      ],
    }),
  });
});

// UI state lives on the server now: start each test from none, like the
// fresh localStorage each test's browser context used to give it.
test.beforeEach(() => resetClientState(tmpHome));

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

  test("a set of questions steps through one at a time and sends every answer on the last one", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("acpquestions", "main"));
    await chatPane.waitForReady();

    await chatPane.typeMessage("quiz me");
    await chatPane.submit();
    await expect(chatPane.elicitationForms).toHaveCount(1);
    // Named after the chat's agent as configured in settings.
    await expect(chatPane.elicitationHeading(0)).toContainText(AGENT_LABEL);
    await expect(chatPane.elicitationQuestion(0)).toHaveText("___ Hund bellt.");
    await expect(chatPane.elicitationSteps(0)).toHaveCount(3);
    await expect(chatPane.elicitationSteps(0).nth(0)).toHaveAttribute("data-state", "current");
    await expect(chatPane.elicitationSteps(0).nth(1)).toHaveAttribute("data-state", "upcoming");
    // The composer waits for the answers.
    await expect(chatPane.composer).toBeDisabled();

    // A number key picks that option; Enter moves on.
    await chatPane.pressKeyInPage("3");
    await expect(chatPane.elicitationChoice(0, "Das")).toHaveAttribute("aria-pressed", "true");
    await chatPane.pressKeyInPage("Enter");
    await expect(chatPane.elicitationQuestion(0)).toHaveText("Which prepositions go with denken?");
    await expect(chatPane.elicitationSteps(0).nth(0)).toHaveAttribute("data-state", "done");
    await expect(chatPane.elicitationSteps(0).nth(1)).toHaveAttribute("data-state", "current");

    // Back returns to the first question with its pick kept.
    await chatPane.clickElicitationButton(0, "Back");
    await expect(chatPane.elicitationChoice(0, "Das")).toHaveAttribute("aria-pressed", "true");
    await chatPane.clickElicitationButton(0, "Next");

    // Pick-any: two options and a note.
    await chatPane.pickElicitationChoice(0, "an");
    await chatPane.pickElicitationChoice(0, "von");
    await chatPane.typeElicitationNote(0, "also nach");
    await chatPane.clickElicitationButton(0, "Next");
    await expect(chatPane.elicitationQuestion(0)).toHaveText("ein ___ Tag");

    // Esc skips the last question, which sends the answers.
    await chatPane.pressKeyInPage("1");
    await expect(chatPane.elicitationChoice(0, "schöner")).toHaveAttribute("aria-pressed", "true");
    await chatPane.pressKeyInPage("Escape");

    await expect(
      chatPane.assistantMessage(
        'Answer: {"question_0":"Das","question_1":["an","von"],"question_1_custom":"also nach"}',
      ),
    ).toBeVisible();
    await expect(chatPane.elicitationForms.nth(0)).toHaveAttribute("data-answered", "true");
    await expect(chatPane.composer).toBeEnabled();
  });

  test("Skip all declines the whole set of questions", async ({ page }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("acpskipall", "main"));
    await chatPane.waitForReady();

    await chatPane.typeMessage("skip me");
    await chatPane.submit();
    await expect(chatPane.elicitationForms).toHaveCount(1);
    await chatPane.pickElicitationChoice(0, "Der");
    await chatPane.clickElicitationButton(0, "Skip all");

    await expect(chatPane.assistantMessage("Skipped all.")).toBeVisible();
    await expect(chatPane.elicitationForms.nth(0)).toHaveAttribute("data-answered", "true");
    await expect(chatPane.composer).toBeEnabled();
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
