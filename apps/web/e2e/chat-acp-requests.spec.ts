/**
 * The chat pane's answers to ACP agent requests, end to end (issue #648).
 *
 *   - A `session/request_permission` renders as a permission card with one
 *     button per option the agent offered. Clicking one answers the request,
 *     marks the card answered, and the agent continues on that branch.
 *   - A form `elicitation/create` (Claude Code's AskUserQuestion) renders as
 *     a question card, one question at a time, with the question as its
 *     title, a "‹ 1 of 3 ›" pager and an X. Picking a single-choice option
 *     (by click, number key, or ↑↓ + Enter) moves on; multi-select and
 *     "Something else" answers move on with Next or Enter; Skip and Esc
 *     leave a question unanswered. The last question sends the values, and
 *     the agent's reply shows what it received. The X declines. The
 *     composer is disabled while the card waits.
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
/** A label no agent ships with, so its absence from the question card shows
 *  the old "<agent> has N questions" heading is gone. */
const AGENT_LABEL = "Stub Helper";
const PROJECTS = [
  "acppermission",
  "acpelicit",
  "acpquestions",
  "acpkeys",
  "acpskip",
  "acpskipall",
  "acpconfirm",
  "acpmodel",
] as const;

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
        {
          match: "^confirm",
          // A form with no fields: only its message, answered with Submit.
          steps: [
            {
              elicitation: {
                message: "Ready to continue?",
                requestedSchema: { type: "object", properties: {} },
              },
            },
          ],
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

  test("a single question is the card's title, has no pager, and a pick sends it", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("acpelicit", "main"));
    await chatPane.waitForReady();

    await chatPane.typeMessage("ask me something");
    await chatPane.submit();
    await expect(chatPane.elicitationForms).toHaveCount(1);
    await expect(chatPane.elicitationForms.nth(0)).toHaveAttribute("data-answered", "false");
    await expect(chatPane.elicitationQuestion(0)).toHaveText("Which color should the button be?");
    await expect(chatPane.elicitationPager(0)).toHaveCount(0);
    await expect(chatPane.elicitationCloseButton(0)).toBeVisible();
    // A single-choice question has no Submit: the pick sends it.
    await expect(chatPane.elicitationButton(0, "Submit")).toHaveCount(0);

    await chatPane.pickElicitationChoice(0, "Blue");

    // The stub echoes the values it received.
    await expect(chatPane.assistantMessage('Answer: {"color":"blue"}')).toBeVisible();
    await expect(chatPane.elicitationForms.nth(0)).toHaveAttribute("data-answered", "true");
  });

  test("a set of questions pages through one at a time and the last pick sends every answer", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("acpquestions", "main"));
    await chatPane.waitForReady();

    await chatPane.typeMessage("quiz me");
    await chatPane.submit();
    await expect(chatPane.elicitationForms).toHaveCount(1);
    await expect(chatPane.elicitationQuestion(0)).toHaveText("___ Hund bellt.");
    // No "<agent> has 3 questions" heading: the configured agent name is nowhere on the card.
    await expect(chatPane.elicitationForms.nth(0)).not.toContainText(AGENT_LABEL);
    await expect(chatPane.elicitationPager(0)).toHaveAttribute("data-index", "1");
    await expect(chatPane.elicitationPager(0)).toHaveAttribute("data-count", "3");
    await expect(chatPane.elicitationPrevButton(0)).toBeDisabled();
    await expect(chatPane.elicitationCloseButton(0)).toBeVisible();
    // Numbered option rows split by dividers, then the "Something else" row.
    await expect(chatPane.elicitationChoiceNumbers(0)).toHaveText(["1", "2", "3"]);
    await expect(chatPane.elicitationDividers(0)).toHaveCount(2);
    await expect(chatPane.elicitationOtherIcon(0)).toBeVisible();
    await expect(chatPane.elicitationNote(0)).toBeVisible();
    await expect(chatPane.elicitationButton(0, "Skip")).toBeVisible();
    await expect(chatPane.elicitationHint(0)).toBeVisible();
    await expect(chatPane.elicitationButton(0, "Next")).toHaveCount(0);
    // The composer waits for the answers.
    await expect(chatPane.composer).toBeDisabled();

    // A number key picks that option and moves on.
    await chatPane.pressKeyInPage("3");
    await expect(chatPane.elicitationQuestion(0)).toHaveText("Which prepositions go with denken?");
    await expect(chatPane.elicitationPager(0)).toHaveAttribute("data-index", "2");
    await expect(chatPane.elicitationPager(0)).toHaveAttribute("data-count", "3");

    // ‹ returns to the first question with its pick kept; › comes back.
    await chatPane.clickElicitationPrev(0);
    await expect(chatPane.elicitationQuestion(0)).toHaveText("___ Hund bellt.");
    await expect(chatPane.elicitationChoice(0, "Das")).toHaveAttribute("aria-pressed", "true");
    await expect(chatPane.elicitationPrevButton(0)).toBeDisabled();
    await chatPane.clickElicitationNextQuestion(0);
    await expect(chatPane.elicitationQuestion(0)).toHaveText("Which prepositions go with denken?");

    // Pick-any stays on its question until Next.
    await chatPane.pickElicitationChoice(0, "an");
    await chatPane.pickElicitationChoice(0, "von");
    await chatPane.typeElicitationNote(0, "also nach");
    await expect(chatPane.elicitationQuestion(0)).toHaveText("Which prepositions go with denken?");

    // › to the last question and ‹ back keeps the picks on this one.
    await chatPane.clickElicitationNextQuestion(0);
    await expect(chatPane.elicitationQuestion(0)).toHaveText("ein ___ Tag");
    await chatPane.clickElicitationPrev(0);
    await expect(chatPane.elicitationChoice(0, "an")).toHaveAttribute("aria-pressed", "true");
    await expect(chatPane.elicitationChoice(0, "von")).toHaveAttribute("aria-pressed", "true");
    await expect(chatPane.elicitationNote(0)).toHaveValue("also nach");

    await chatPane.clickElicitationButton(0, "Next");
    await expect(chatPane.elicitationQuestion(0)).toHaveText("ein ___ Tag");
    await expect(chatPane.elicitationPager(0)).toHaveAttribute("data-index", "3");
    await expect(chatPane.elicitationPager(0)).toHaveAttribute("data-count", "3");
    await expect(chatPane.elicitationNextQuestionButton(0)).toBeDisabled();

    // A click on the last question sends the answers right away.
    await chatPane.pickElicitationChoice(0, "schöner");

    await expect(
      chatPane.assistantMessage(
        'Answer: {"question_0":"Das","question_1":["an","von"],"question_1_custom":"also nach","question_2":"schöner"}',
      ),
    ).toBeVisible();
    await expect(chatPane.elicitationForms.nth(0)).toHaveAttribute("data-answered", "true");
    await expect(chatPane.elicitationHint(0)).toHaveCount(0);
    await expect(chatPane.composer).toBeEnabled();
  });

  test("arrow keys move a highlight through the options and Enter picks it", async ({ page }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("acpkeys", "main"));
    await chatPane.waitForReady();

    await chatPane.typeMessage("quiz me");
    await chatPane.submit();
    await expect(chatPane.elicitationQuestion(0)).toHaveText("___ Hund bellt.");

    // ↓ runs through the options and the "Something else" row, then wraps.
    await chatPane.pressKeyInPage("ArrowDown");
    await expect(chatPane.elicitationChoice(0, "Der")).toHaveAttribute("data-highlighted", "true");
    await chatPane.pressKeyInPage("ArrowDown");
    await chatPane.pressKeyInPage("ArrowDown");
    await expect(chatPane.elicitationChoice(0, "Das")).toHaveAttribute("data-highlighted", "true");
    await chatPane.pressKeyInPage("ArrowDown");
    await expect(chatPane.elicitationOtherRow(0)).toHaveAttribute("data-highlighted", "true");
    await chatPane.pressKeyInPage("ArrowDown");
    await expect(chatPane.elicitationChoice(0, "Der")).toHaveAttribute("data-highlighted", "true");
    await chatPane.pressKeyInPage("ArrowUp");
    await chatPane.pressKeyInPage("ArrowUp");
    await expect(chatPane.elicitationChoice(0, "Das")).toHaveAttribute("data-highlighted", "true");

    // Enter picks the highlighted single-choice option and moves on.
    await chatPane.pressKeyInPage("Enter");
    await expect(chatPane.elicitationQuestion(0)).toHaveText("Which prepositions go with denken?");

    // On a pick-any question Enter on the highlight and number keys toggle
    // without moving on.
    await chatPane.pressKeyInPage("ArrowDown");
    await chatPane.pressKeyInPage("Enter");
    await expect(chatPane.elicitationChoice(0, "an")).toHaveAttribute("aria-pressed", "true");
    await chatPane.pressKeyInPage("4");
    await expect(chatPane.elicitationChoice(0, "auf")).toHaveAttribute("aria-pressed", "true");
    await expect(chatPane.elicitationQuestion(0)).toHaveText("Which prepositions go with denken?");

    // Enter on the "Something else" row puts the cursor in its box, where
    // numbers and arrows are just typing. ↑ from the first option wraps to it.
    await chatPane.pressKeyInPage("ArrowUp");
    await expect(chatPane.elicitationOtherRow(0)).toHaveAttribute("data-highlighted", "true");
    await chatPane.pressKeyInPage("Enter");
    await expect(chatPane.elicitationNote(0)).toBeFocused();
    await chatPane.pressKeyInPage("2");
    await chatPane.pressKeyInPage("ArrowUp");
    await expect(chatPane.elicitationNote(0)).toHaveValue("2");
    await expect(chatPane.elicitationChoice(0, "über")).toHaveAttribute("aria-pressed", "false");
    await expect(chatPane.elicitationOtherRow(0)).toHaveAttribute("data-highlighted", "true");

    // Esc in the box only leaves it: the text stays and the question doesn't change.
    await chatPane.pressKeyInPage("Escape");
    await expect(chatPane.elicitationNote(0)).not.toBeFocused();
    await expect(chatPane.elicitationNote(0)).toHaveValue("2");
    await expect(chatPane.elicitationQuestion(0)).toHaveText("Which prepositions go with denken?");
    await chatPane.pressKeyInPage("Enter");
    await expect(chatPane.elicitationNote(0)).toBeFocused();
    await chatPane.pressKeyInPage("Enter");
    await expect(chatPane.elicitationQuestion(0)).toHaveText("ein ___ Tag");

    // With nothing highlighted, a stray Enter on a single-choice question
    // only highlights the first option; it doesn't send.
    await chatPane.pressKeyInPage("Enter");
    await expect(chatPane.elicitationChoice(0, "schöner")).toHaveAttribute(
      "data-highlighted",
      "true",
    );
    await expect(chatPane.elicitationForms.nth(0)).toHaveAttribute("data-answered", "false");

    // A typed answer on the last question sends with Submit.
    await chatPane.typeElicitationNote(0, "sonniger");
    await chatPane.clickElicitationButton(0, "Submit");
    await expect(
      chatPane.assistantMessage(
        'Answer: {"question_0":"Das","question_1":["an","auf"],"question_1_custom":"2","question_2_custom":"sonniger"}',
      ),
    ).toBeVisible();
    await expect(chatPane.elicitationForms.nth(0)).toHaveAttribute("data-answered", "true");
    await expect(chatPane.composer).toBeEnabled();
  });

  test("Skip and Esc leave a question unanswered, and a typed answer moves on with Next", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("acpskip", "main"));
    await chatPane.waitForReady();

    await chatPane.typeMessage("quiz me");
    await chatPane.submit();
    await expect(chatPane.elicitationQuestion(0)).toHaveText("___ Hund bellt.");

    // Typing "Something else" on a single-choice question brings up Next.
    await chatPane.typeElicitationNote(0, "Ein");
    await expect(chatPane.elicitationQuestion(0)).toHaveText("___ Hund bellt.");
    await chatPane.clickElicitationButton(0, "Next");
    await expect(chatPane.elicitationQuestion(0)).toHaveText("Which prepositions go with denken?");

    // Esc drops this question's picks and moves on without sending.
    await chatPane.pickElicitationChoice(0, "über");
    await chatPane.pressKeyInPage("Escape");
    await expect(chatPane.elicitationQuestion(0)).toHaveText("ein ___ Tag");
    await expect(chatPane.elicitationForms.nth(0)).toHaveAttribute("data-answered", "false");

    // Skip on the last question skips it and sends the answers.
    await chatPane.clickElicitationButton(0, "Skip");
    await expect(chatPane.assistantMessage('Answer: {"question_0_custom":"Ein"}')).toBeVisible();
    await expect(chatPane.elicitationForms.nth(0)).toHaveAttribute("data-answered", "true");
  });

  test("the X declines the whole set of questions", async ({ page }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("acpskipall", "main"));
    await chatPane.waitForReady();

    await chatPane.typeMessage("skip me");
    await chatPane.submit();
    await expect(chatPane.elicitationForms).toHaveCount(1);
    await chatPane.pickElicitationChoice(0, "Der");
    await expect(chatPane.elicitationPager(0)).toHaveAttribute("data-index", "2");
    await expect(chatPane.elicitationPager(0)).toHaveAttribute("data-count", "3");
    // A number key toggles a pick-any option; Enter then moves on.
    await chatPane.pressKeyInPage("1");
    await expect(chatPane.elicitationChoice(0, "an")).toHaveAttribute("aria-pressed", "true");
    await chatPane.pressKeyInPage("Enter");
    await expect(chatPane.elicitationPager(0)).toHaveAttribute("data-index", "3");
    await chatPane.closeElicitation(0);

    await expect(chatPane.assistantMessage("Skipped all.")).toBeVisible();
    await expect(chatPane.elicitationForms.nth(0)).toHaveAttribute("data-answered", "true");
    await expect(chatPane.composer).toBeEnabled();
  });

  test("a form with no fields shows its message and answers with Submit", async ({ page }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("acpconfirm", "main"));
    await chatPane.waitForReady();

    await chatPane.typeMessage("confirm it");
    await chatPane.submit();
    await expect(chatPane.elicitationQuestion(0)).toHaveText("Ready to continue?");
    await expect(chatPane.elicitationCloseButton(0)).toBeVisible();
    await expect(chatPane.elicitationPager(0)).toHaveCount(0);

    await chatPane.clickElicitationButton(0, "Submit");
    await expect(chatPane.assistantMessage("Answer: {}")).toBeVisible();
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
