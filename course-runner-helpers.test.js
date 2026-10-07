const test = require("node:test");
const assert = require("node:assert/strict");

test("zero-point multi-select retains individually confirmed correct choices", () => {
  const h = require("./course-runner-helpers.js");
  const memory = h.mergeQuestionMemory(null, { prompt: "Impact factors", type: "multi_select", hasCheckbox: true,
    status: "incorrect", chosenOptions: ["Cost", "Stakeholders", "Threats"],
    confirmedCorrectOptions: ["Cost", "Stakeholders"], specificWrongOptions: ["Threats"] });
  assert.deepEqual(memory.confirmedCorrectOptions, ["Cost", "Stakeholders"]);
  assert.deepEqual(memory.knownWrongOptions, ["Threats"]);
  assert.equal(memory.wrongAttempts.length, 1);
  const again = h.mergeQuestionMemory(memory, { prompt: "Impact factors", type: "multi_select", hasCheckbox: true,
    status: "incorrect", chosenOptions: ["Cost", "Stakeholders"] });
  assert.deepEqual(again.confirmedCorrectOptions, ["Cost", "Stakeholders"]);
});

test("option feedback interprets selection state rather than the total question score", () => {
  const { classifyOptionFeedback } = require("./course-runner-helpers.js");
  assert.equal(classifyOptionFeedback("Nice work. That's correct.", true), "correct");
  assert.equal(classifyOptionFeedback("Try again. Not quite.", true), "incorrect");
  assert.equal(classifyOptionFeedback("Try again. Not quite.", false), "correct");
  assert.equal(classifyOptionFeedback("Nice work. That's correct.", false), "incorrect");
  assert.equal(classifyOptionFeedback("This should not be selected", true), "incorrect");
});

test("full review text is sent in order without losing any content", async () => {
  const { sendFullFeedback } = require("./course-runner-helpers.js");
  const text = "Question, chosen answer, incorrect explanation.\n".repeat(250);
  const parts = [];
  await sendFullFeedback({ text, send: async (part, index, total) => {
    assert.equal(index, parts.length);
    assert.ok(total > 1);
    assert.ok(part.length <= 4000);
    parts.push(part);
    return "Acknowledged";
  } });
  assert.equal(parts.join(""), text);
});

test("feedback transmission failure prevents completion of the feedback step", async () => {
  const { sendFullFeedback } = require("./course-runner-helpers.js");
  let sent = 0;
  await assert.rejects(sendFullFeedback({ text: "x".repeat(10000), send: async () => {
    if (++sent === 2) throw new Error("Gemini unavailable");
    return "OK";
  } }), /Gemini unavailable/);
  assert.equal(sent, 2);
});

test("resume transition waits for minimum delay and stable fully loaded content", () => {
  const { resolveAssignmentTransition } = require("./course-runner-helpers.js");
  const state = { elapsedMs: 9000, stableForMs: 3500, readyState: "complete", text: "Questions loaded" };
  assert.equal(resolveAssignmentTransition({ ...state, elapsedMs: 1000 }), "wait");
  assert.equal(resolveAssignmentTransition({ ...state, readyState: "interactive" }), "wait");
  assert.equal(resolveAssignmentTransition({ ...state, stableForMs: 1000 }), "wait");
  assert.equal(resolveAssignmentTransition({ ...state, text: "" }), "wait");
  assert.equal(resolveAssignmentTransition(state), "ready");
  assert.equal(resolveAssignmentTransition({ ...state, text: "", elapsedMs: 45000 }), "timeout");
});

test("copy question text reads the highlighted selection and restores the prior selection", () => {
  const { copyRenderedQuestionText } = require("./course-runner-helpers.js");
  const oldRange = { cloneRange() { return this; } };
  const selection = { rangeCount: 1, getRangeAt: () => oldRange,
    removeAllRanges() { this.current = null; }, addRange(range) { this.current = range; },
    toString: () => "Visible question\nA. First\nB. Second" };
  const container = { textContent: "Hidden JSON must not be copied" };
  const doc = { createRange: () => ({ selectNodeContents(node) { assert.equal(node, container); } }) };
  assert.equal(copyRenderedQuestionText(container, doc, { getSelection: () => selection }), "Visible question\nA. First\nB. Second");
  assert.equal(selection.current, oldRange);
});

test("image fallback sends every captured question section in order", async () => {
  const { solveQuizTextFirst } = require("./course-runner-helpers.js");
  await solveQuizTextFirst({ prompt: "Question",
    solve: async (_prompt, options) => {
      if (!options.screenshotUrls) throw new Error("Need image");
      assert.deepEqual(options.screenshotUrls, ["first", "second"]);
      return [{ content: "Answer" }];
    }, capture: async () => ["first", "second"],
  });
});

test("text-first solver avoids screenshots when text succeeds", async () => {
  const { solveQuizTextFirst } = require("./course-runner-helpers.js");
  let captured = false;
  const result = await solveQuizTextFirst({
    prompt: "Full question and feedback",
    solve: async (prompt, options) => {
      assert.equal(prompt, "Full question and feedback");
      assert.equal(options.screenshotUrl, undefined);
      return [{ content: "Answer" }];
    },
    capture: async () => { captured = true; return "image"; },
  });
  assert.equal(captured, false);
  assert.equal(result[0].content, "Answer");
});

test("text-first solver captures only after text fails or returns no answers", async () => {
  const { solveQuizTextFirst } = require("./course-runner-helpers.js");
  for (const empty of [false, true]) {
    const calls = [];
    const result = await solveQuizTextFirst({ prompt: "Question",
      solve: async (_prompt, options) => {
        calls.push(options.screenshotUrl ? "image" : "text");
        if (!options.screenshotUrl) {
          if (empty) return [];
          throw new Error("Cannot read diagram");
        }
        return [{ content: "Visual answer" }];
      },
      capture: async () => { calls.push("capture"); return "data:image/png;base64,abc"; },
    });
    assert.deepEqual(calls, ["text", "capture", "image"]);
    assert.equal(result[0].content, "Visual answer");
  }
});

test("blank quiz pages wait for loading and time out without being treated as ready", () => {
  const { resolveQuizPageLoadState } = require("./course-runner-helpers.js");
  assert.equal(resolveQuizPageLoadState({ readyState: "loading", text: "", elapsedMs: 0 }), "wait");
  assert.equal(resolveQuizPageLoadState({ readyState: "complete", text: "  ", elapsedMs: 5000 }), "wait");
  assert.equal(resolveQuizPageLoadState({ readyState: "complete", text: "", elapsedMs: 30000 }), "timeout");
  assert.equal(resolveQuizPageLoadState({ readyState: "complete", text: "Ready to start the Activity?", elapsedMs: 1000 }), "ready");
});

test("retry context survives storage round trip with full feedback and earlier attempts", () => {
  const helpers = require("./course-runner-helpers.js");
  const feedback = "Detailed rubric feedback. ".repeat(200);
  let history = helpers.recordQuizAttemptHistory([], {
    scorePercent: 66.66, passingThreshold: 80, rawFeedback: feedback,
    assignmentContext: "Original scenario", itemPath: "/learn/course/quiz/item",
    questions: [{ prompt: "Explain impact", type: "text", allOptions: ["A", "B"], chosenOptions: ["My essay"], feedback: "Missing people impact" }],
  });
  history = helpers.recordQuizAttemptHistory(history, { scorePercent: 70, rawFeedback: "Still incomplete" });
  const report = helpers.buildPreviousAttemptReport(JSON.parse(JSON.stringify(history)), { title: "Impact analysis" });
  assert.equal(report.attemptHistory[0].rawFeedback, feedback);
  assert.equal(report.attemptHistory[0].assignmentContext, "Original scenario");
  assert.deepEqual(report.attemptHistory[0].questions[0].chosenOptions, ["My essay"]);
  assert.equal(report.rawFeedback, "Still incomplete");
  const firstReport = helpers.buildPreviousAttemptReport(history.slice(0, 1));
  assert.deepEqual(firstReport.submittedQuestions[0].allOptions, ["A", "B"]);
});

const {
  buildCourseMaterialsUrl,
  buildRunnerLogEntry,
  buildRunnerLogMessage,
  classifyQuizStateText,
  describeRunnerLogEntry,
  flattenCourseStructure,
  formatRunnerLogExport,
  getItemSlug,
  inferSidebarCompletionSignals,
  isContinueActionLabel,
  isEligibleQuizItem,
  isEligibleQuizRunItem,
  isStartActionLabel,
  isSubmitActionLabel,
  isUngradedAppItem,
  matchesItemPath,
  normalizeQuizResultSettleSeconds,
  normalizePath,
  pickFirstIncomplete,
  pickFirstIncompleteQuiz,
  resolveAttemptRelayState,
  resolveStartActionState,
  resolveSolverFillState,
  shouldTreatExistingAttemptAsPassed,
  shouldTreatQuizStateAsFinal,
  guessItemType,
  normalizeQuestionKey,
  normalizeOptionText,
  isOptionMatching,
  isQuizAttemptLocked,
  extractPointsFromText,
  classifyReviewStatus,
  mergeQuestionMemory,
  formatMemoryForPrompt,
  isRetryActionLabel,
  normalizeVisionDecision,
  isMatchingClickableText,
  checkQuizSubmissionQualityGates,
  isCancelActionLabel,
  isSubmitConfirmDialogBlocked,
  isUnansweredNoticeText,
  DEFAULT_PASSING_PERCENT,
  extractGradePercentage,
  extractPassingThreshold,
  buildPreviousAttemptReport,
  formatQuestionPreviousAttempt,
  isSameOptionCombination,
  recordQuizAttemptHistory,
  extractCourseSlug,
  extractItemId,
  isPathSkipped,
  isPeerAssignmentSubmitted,
  isTextQuestionAnswered,
} = require("./course-runner-helpers");

test("normalizePath strips origin, query, and trailing slash", () => {
  assert.equal(
    normalizePath("https://www.coursera.org/learn/demo/lecture/intro/?foo=1"),
    "/learn/demo/lecture/intro"
  );
  assert.equal(normalizePath("/learn/demo/"), "/learn/demo");
});

test("normalizeQuizResultSettleSeconds defaults and clamps invalid values", () => {
  assert.equal(normalizeQuizResultSettleSeconds(undefined), 4);
  assert.equal(normalizeQuizResultSettleSeconds("10"), 10);
  assert.equal(normalizeQuizResultSettleSeconds("0"), 1);
  assert.equal(normalizeQuizResultSettleSeconds("200"), 120);
  assert.equal(normalizeQuizResultSettleSeconds("abc"), 4);
});

test("buildCourseMaterialsUrl encodes the slug for the Coursera API", () => {
  assert.equal(
    buildCourseMaterialsUrl("machine learning"),
    "/api/ondemandcoursematerials.v2/?q=slug&slug=machine%20learning&includes=modules"
  );
});

test("guessItemType classifies quizzes from the path and title", () => {
  assert.equal(
    guessItemType("/learn/demo/quiz/week-1", "Week 1 quiz"),
    "quiz"
  );
  assert.equal(
    guessItemType("/learn/demo/lecture/intro", "Introduction"),
    "lesson"
  );
  assert.equal(
    guessItemType(
      "/learn/demo/ungradedLti/abc/practice-lab-text-analysis",
      "Practice Lab: Text Analysis Ungraded App Item"
    ),
    "app"
  );
});

test("flattenCourseStructure returns ordered course items from nested API data", () => {
  const payload = {
    linked: {
      "onDemandModules.v1": [
        {
          id: "module-1",
          name: "Week 1",
          elements: [
            {
              id: "item-1",
              name: "Welcome",
              contentSummary: {
                typeName: "lecture",
                definition: {
                  url: "/learn/demo/lecture/welcome",
                },
              },
            },
            {
              id: "item-2",
              name: "Week 1 quiz",
              contentSummary: {
                typeName: "quiz",
                definition: {
                  url: "/learn/demo/quiz/week-1",
                },
              },
            },
          ],
        },
      ],
    },
  };

  assert.deepEqual(flattenCourseStructure(payload), [
    {
      id: "item-1",
      title: "Welcome",
      path: "/learn/demo/lecture/welcome",
      type: "lesson",
      moduleId: "module-1",
      moduleTitle: "Week 1",
    },
    {
      id: "item-2",
      title: "Week 1 quiz",
      path: "/learn/demo/quiz/week-1",
      type: "quiz",
      moduleId: "module-1",
      moduleTitle: "Week 1",
    },
  ]);
});

test("pickFirstIncomplete chooses the earliest incomplete item from the ordered list", () => {
  const items = [
    { path: "/learn/demo/lecture/welcome", type: "lesson" },
    { path: "/learn/demo/quiz/week-1", type: "quiz" },
    { path: "/learn/demo/lecture/next", type: "lesson" },
  ];

  const completionMap = new Map([
    ["/learn/demo/lecture/welcome", true],
    ["/learn/demo/quiz/week-1", false],
    ["/learn/demo/lecture/next", false],
  ]);

  assert.deepEqual(pickFirstIncomplete(items, completionMap), items[1]);
});

test("isEligibleQuizItem keeps practice and graded quiz attempts only", () => {
  assert.equal(
    isEligibleQuizItem({
      type: "quiz",
      path: "/learn/demo/quiz/week-1",
      title: "Practice Quiz 1",
    }),
    true
  );
  assert.equal(
    isEligibleQuizItem({
      type: "quiz",
      path: "/learn/demo/assignment-submission/abc/graded-quiz-week-2",
      title: "Graded Quiz Week 2",
    }),
    true
  );
  assert.equal(
    isEligibleQuizItem({
      type: "quiz",
      path: "/learn/demo/programming/assignment-1",
      title: "Programming Assignment 1",
    }),
    false
  );
  assert.equal(
    isEligibleQuizItem({
      type: "lesson",
      path: "/learn/demo/lecture/intro",
      title: "Course Introduction",
    }),
    false
  );
  assert.equal(
    isEligibleQuizItem({
      type: "app",
      path: "/learn/demo/ungradedLti/abc/practice-lab-text-analysis",
      title: "Practice Lab: Text Analysis Ungraded App Item",
    }),
    false
  );
  assert.equal(
    isEligibleQuizItem({
      type: "quiz",
      path: "/learn/address-business-issues-with-data-science/peer/jRIKy/initiating-a-data-science-project",
      title: "Practice Peer-graded Assignment: Initiating a Data Science Project",
    }),
    true
  );
  assert.equal(
    isEligibleQuizItem({
      type: "quiz",
      path: "/learn/demo/peer/xyz/final-peer-review",
      title: "Peer-graded Assignment: Final Course Project",
    }),
    true
  );
  assert.equal(
    isEligibleQuizItem({
      type: "quiz",
      path: "/learn/address-business-issues-with-data-science/peer/jRIKy/initiating-a-data-science-project/submit",
      title: "Initiating a Data Science Project Graded Assignment",
    }),
    true
  );
});

test("isUngradedAppItem detects Coursera ungraded LTI app items only", () => {
  assert.equal(
    isUngradedAppItem({
      type: "app",
      path: "/learn/demo/ungradedLti/abc/practice-lab-text-analysis",
      title: "Practice Lab: Text Analysis Ungraded App Item",
    }),
    true
  );
  assert.equal(
    isUngradedAppItem({
      type: "lesson",
      path: "/learn/demo/lecture/intro",
      title: "Course Introduction",
    }),
    false
  );
});

test("isEligibleQuizRunItem includes quizzes and ungraded app items", () => {
  assert.equal(
    isEligibleQuizRunItem({
      type: "quiz",
      path: "/learn/demo/quiz/week-1",
      title: "Practice Quiz 1",
    }),
    true
  );
  assert.equal(
    isEligibleQuizRunItem({
      type: "app",
      path: "/learn/demo/ungradedLti/abc/practice-lab-text-analysis",
      title: "Practice Lab: Text Analysis Ungraded App Item",
    }),
    true
  );
  assert.equal(
    isEligibleQuizRunItem({
      type: "lesson",
      path: "/learn/demo/lecture/intro",
      title: "Course Introduction",
    }),
    false
  );
});

test("pickFirstIncompleteQuiz chooses the earliest incomplete eligible quiz or app item", () => {
  const items = [
    { path: "/learn/demo/lecture/welcome", type: "lesson", title: "Welcome" },
    { path: "/learn/demo/programming/week-1", type: "quiz", title: "Programming Assignment" },
    {
      path: "/learn/demo/ungradedLti/abc/practice-lab-text-analysis",
      type: "app",
      title: "Practice Lab: Text Analysis Ungraded App Item",
    },
    { path: "/learn/demo/quiz/week-1", type: "quiz", title: "Practice Quiz 1" },
    {
      path: "/learn/demo/assignment-submission/abc/graded-quiz-week-2",
      type: "quiz",
      title: "Graded Quiz Week 2",
    },
  ];

  const completionMap = new Map([
    ["/learn/demo/lecture/welcome", true],
    ["/learn/demo/programming/week-1", false],
    ["/learn/demo/ungradedLti/abc/practice-lab-text-analysis", false],
    ["/learn/demo/quiz/week-1", false],
    ["/learn/demo/assignment-submission/abc/graded-quiz-week-2", false],
  ]);

  assert.deepEqual(pickFirstIncompleteQuiz(items, completionMap), items[2]);
});

test("inferSidebarCompletionSignals detects completed quiz markers from Coursera sidebar", () => {
  assert.equal(
    inferSidebarCompletionSignals({
      ariaLabel:
        "Practice Assignment, Practice Quiz: Lesson 1, Completed, Grade: 100%",
      text: "Practice Assignment Grade: 100%",
      hasSuccessIcon: true,
    }),
    true
  );
});

test("inferSidebarCompletionSignals detects not-submitted quiz markers from Coursera sidebar", () => {
  assert.equal(
    inferSidebarCompletionSignals({
      ariaLabel:
        "selected link, Practice Assignment, Practice Quiz: Modern Data Ecosystem, Not submitted, 9 min",
      text: "Practice Assignment 9 min",
      hasSuccessIcon: false,
    }),
    false
  );
});

test("isSubmitActionLabel recognizes submit-style quiz actions", () => {
  assert.equal(isSubmitActionLabel("Submit"), true);
  assert.equal(isSubmitActionLabel("Submit assignment"), true);
  assert.equal(isSubmitActionLabel("Check"), true);
  assert.equal(isSubmitActionLabel("Try again"), false);
});

test("isContinueActionLabel recognizes post-submit navigation actions", () => {
  assert.equal(isContinueActionLabel("Continue"), true);
  assert.equal(isContinueActionLabel("Next"), true);
  assert.equal(isContinueActionLabel("Go to next item"), true);
  assert.equal(isContinueActionLabel("Submit"), false);
});

test("isStartActionLabel recognizes quiz cover page entry actions", () => {
  assert.equal(isStartActionLabel("Start"), true);
  assert.equal(isStartActionLabel("Start quiz"), true);
  assert.equal(isStartActionLabel("Start assignment"), true);
  assert.equal(isStartActionLabel("Resume"), true);
  assert.equal(isStartActionLabel("Resume assignment"), true);
  assert.equal(isStartActionLabel("Resume quiz"), true);
  assert.equal(isStartActionLabel("Begin"), true);
  assert.equal(isStartActionLabel("Continue"), false);
  assert.equal(isStartActionLabel("Help me practice"), false);
  assert.equal(isStartActionLabel("Review"), false);
  assert.equal(isStartActionLabel("Go to next item ->"), false);
  assert.equal(isStartActionLabel("Next item"), false);
});

test("classifyQuizStateText distinguishes pending, passed, and failed states", () => {
  assert.equal(classifyQuizStateText("Submit your quiz answers"), "pending");
  assert.equal(classifyQuizStateText("Congratulations, you passed this assignment"), "passed");
  assert.equal(classifyQuizStateText("Try again. You did not pass this time."), "failed");
  assert.equal(
    classifyQuizStateText("Your grade You haven't submitted this yet. We keep your highest score. Resume"),
    "pending"
  );
  assert.equal(
    classifyQuizStateText("Practice Quiz: Types Grade: 100%"),
    "pending"
  );
});

test("shouldTreatExistingAttemptAsPassed rejects resume-style pages that are not submitted yet", () => {
  assert.equal(
    shouldTreatExistingAttemptAsPassed({
      quizState: "passed",
      hasNextButton: true,
      startLabel: "Resume",
      pageText: "Your grade You haven't submitted this yet. We keep your highest score.",
    }),
    false
  );

  assert.equal(
    shouldTreatExistingAttemptAsPassed({
      quizState: "passed",
      hasNextButton: true,
      startLabel: "",
      pageText: "Congratulations, you passed this assignment.",
    }),
    true
  );
});

test("shouldTreatExistingAttemptAsPassed rejects weak passed text without a result marker", () => {
  assert.equal(
    shouldTreatExistingAttemptAsPassed({
      quizState: "passed",
      hasNextButton: true,
      startLabel: "",
      pageText: "Some sidebar item completed this module. Go to next item.",
    }),
    false
  );
});

test("buildRunnerLogMessage creates a stable readable prefix and payload", () => {
  assert.equal(
    buildRunnerLogMessage("quiz_submit", {
      title: "Practice Quiz",
      path: "/learn/demo/quiz/week-1",
      reason: undefined,
    }),
    "[AutoCoursera][MakeDoneAll] quiz_submit {\"title\":\"Practice Quiz\",\"path\":\"/learn/demo/quiz/week-1\"}"
  );
});

test("buildRunnerLogEntry keeps structured runner log data", () => {
  assert.deepEqual(
    buildRunnerLogEntry("quiz_start", { title: "Practice Quiz" }, {
      level: "info",
      mode: "quiz",
      path: "/learn/demo/quiz/week-1",
      timestamp: "2026-05-18T10:00:00.000Z",
    }),
    {
      timestamp: "2026-05-18T10:00:00.000Z",
      eventName: "quiz_start",
      level: "info",
      mode: "quiz",
      path: "/learn/demo/quiz/week-1",
      details: { title: "Practice Quiz" },
      message:
        "[AutoCoursera][MakeDoneAll] quiz_start {\"title\":\"Practice Quiz\"}",
    }
  );
});

test("formatRunnerLogExport creates line-based log file content", () => {
  const formatted = formatRunnerLogExport([
    {
      timestamp: "2026-05-18T10:00:00.000Z",
      eventName: "quiz_start",
      level: "info",
      mode: "quiz",
      path: "/learn/demo/quiz/week-1",
      details: { title: "Practice Quiz" },
      message:
        "[AutoCoursera][MakeDoneAll] quiz_start {\"title\":\"Practice Quiz\"}",
    },
    {
      timestamp: "2026-05-18T10:00:02.000Z",
      eventName: "quiz_click_submit",
      level: "info",
      mode: "quiz",
      path: "/learn/demo/quiz/week-1/attempt",
      details: { title: "Practice Quiz" },
      message:
        "[AutoCoursera][MakeDoneAll] quiz_click_submit {\"title\":\"Practice Quiz\"}",
    },
  ]);

  assert.equal(
    formatted,
    [
      "2026-05-18T10:00:00.000Z [INFO] [quiz] /learn/demo/quiz/week-1 [AutoCoursera][MakeDoneAll] quiz_start {\"title\":\"Practice Quiz\"}",
      "2026-05-18T10:00:02.000Z [INFO] [quiz] /learn/demo/quiz/week-1/attempt [AutoCoursera][MakeDoneAll] quiz_click_submit {\"title\":\"Practice Quiz\"}",
    ].join("\n")
  );
});

test("describeRunnerLogEntry renders readable scan and quiz steps for popup", () => {
  assert.equal(
    describeRunnerLogEntry({
      eventName: "quiz_scan_item",
      details: {
        title: "Practice Quiz: Modern Data Ecosystem",
        decision: "start_quiz",
      },
    }),
    'Đọc "Practice Quiz: Modern Data Ecosystem" => bắt đầu quiz'
  );

  assert.equal(
    describeRunnerLogEntry({
      eventName: "quiz_click_submit",
      level: "info",
      details: {
        title: "Practice Quiz: Modern Data Ecosystem",
      },
    }),
    "Submit quiz"
  );

  assert.equal(
    describeRunnerLogEntry({
      eventName: "quiz_error",
      level: "error",
      details: {
        message: "Cannot read properties of null",
      },
    }),
    "Lỗi: Cannot read properties of null"
  );

  assert.equal(
    describeRunnerLogEntry({
      eventName: "quiz_dom_snapshot",
      details: {
        stage: "before_attempt_relay",
        hasStartButton: false,
        hasSubmitButton: true,
        hasConfirmButton: false,
        hasNextButton: false,
        hasAgreementCheckbox: true,
        quizState: "pending",
      },
    }),
    "DOM snapshot [before_attempt_relay]: start=no, submit=yes, confirm=no, next=no, checkbox=yes, state=pending"
  );

  assert.equal(
    describeRunnerLogEntry({
      eventName: "app_item_wait_before_launch",
      details: { seconds: 4 },
    }),
    "Chờ 4s trước khi bấm Launch App"
  );

  assert.equal(
    describeRunnerLogEntry({
      eventName: "app_item_launch_clicked",
      details: {},
    }),
    'Bấm "Launch App"'
  );
});

test("shouldTreatQuizStateAsFinal ignores passed state before submit starts", () => {
  assert.equal(shouldTreatQuizStateAsFinal("passed", false), false);
  assert.equal(shouldTreatQuizStateAsFinal("failed", false), false);
  assert.equal(shouldTreatQuizStateAsFinal("passed", true), true);
  assert.equal(shouldTreatQuizStateAsFinal("failed", true), true);
});

test("resolveStartActionState waits for transition after one start click", () => {
  assert.equal(
    resolveStartActionState({
      hasStartButton: true,
      startClickedAt: 0,
      now: 1000,
      transitionTimeoutMs: 4000,
    }),
    "click"
  );
  assert.equal(
    resolveStartActionState({
      hasStartButton: true,
      startClickedAt: 1500,
      now: 3000,
      transitionTimeoutMs: 4000,
    }),
    "wait"
  );
  assert.equal(
    resolveStartActionState({
      hasStartButton: true,
      startClickedAt: 1000,
      now: 6001,
      transitionTimeoutMs: 4000,
    }),
    "timeout"
  );
  assert.equal(
    resolveStartActionState({
      hasStartButton: false,
      startClickedAt: 1000,
      now: 3000,
      transitionTimeoutMs: 4000,
    }),
    "gone"
  );
  assert.equal(
    resolveStartActionState({
      hasStartButton: true,
      hasStartModalButton: true,
      startClickedAt: 1000,
      now: 3000,
      transitionTimeoutMs: 4000,
    }),
    "confirm_modal"
  );
  assert.equal(
    resolveStartActionState({
      hasStartButton: true,
      hasQuizWorkControls: true,
      startClickedAt: 1000,
      now: 3000,
      transitionTimeoutMs: 4000,
    }),
    "gone"
  );
});

test("resolveAttemptRelayState waits before calling the AI solver", () => {
  assert.equal(
    resolveAttemptRelayState({
      controlsReadyAt: 1000,
      now: 2500,
      delayMs: 3000,
    }),
    "wait"
  );
  assert.equal(
    resolveAttemptRelayState({
      controlsReadyAt: 1000,
      now: 4000,
      delayMs: 3000,
    }),
    "ready"
  );
});

test("resolveSolverFillState waits until AI-filled answers are stable", () => {
  const base = {
    baselineAnsweredCount: 0,
    baselineSignature: "",
    currentAnsweredCount: 2,
    currentSignature: "q1:a|q2:b",
    relayedAt: 1000,
    lastChangedAt: 2500,
    minWaitMs: 3000,
    stableMs: 2000,
    timeoutMs: 45000,
  };

  assert.equal(resolveSolverFillState({ ...base, now: 3500 }), "wait");
  assert.equal(resolveSolverFillState({ ...base, now: 4400 }), "wait");
  assert.equal(resolveSolverFillState({ ...base, now: 5600 }), "ready");
});

test("resolveSolverFillState times out when answers never change", () => {
  assert.equal(
    resolveSolverFillState({
      baselineAnsweredCount: 0,
      baselineSignature: "",
      currentAnsweredCount: 0,
      currentSignature: "",
      relayedAt: 1000,
      lastChangedAt: 1000,
      now: 47000,
      minWaitMs: 3000,
      stableMs: 2000,
      timeoutMs: 45000,
    }),
    "timeout"
  );
});

test("getItemSlug extracts the last path slug excluding attempt", () => {
  assert.equal(
    getItemSlug("/learn/course/exam/gD3QI/2-4-3-beyond-bullet-points"),
    "2-4-3-beyond-bullet-points"
  );
  assert.equal(
    getItemSlug("/learn/course/assignment-submission/gD3QI/2-4-3-beyond-bullet-points/attempt"),
    "2-4-3-beyond-bullet-points"
  );
  assert.equal(getItemSlug(""), "");
});

test("matchesItemPath correctly compares attempt URLs with item paths", () => {
  const itemPath243 = "/learn/course/exam/gD3QI/2-4-3-beyond-bullet-points";
  const attemptPath243 = "/learn/course/assignment-submission/gD3QI/2-4-3-beyond-bullet-points/attempt";
  const itemPath253 = "/learn/course/exam/xYz12/2-5-3-compelling-online-presentations";

  // Same quiz matches despite /exam/ vs /assignment-submission/.../attempt
  assert.equal(matchesItemPath(attemptPath243, itemPath243), true);

  // View-feedback and instructions also match item path
  const feedbackPath243 = "/learn/course/assignment-submission/gD3QI/2-4-3-beyond-bullet-points/view-feedback";
  assert.equal(matchesItemPath(feedbackPath243, itemPath243), true);

  // Different quizzes do NOT match
  assert.equal(matchesItemPath(attemptPath243, itemPath253), false);
  assert.equal(matchesItemPath(itemPath243, itemPath253), false);
});

test("normalizeQuestionKey strips question numbers, points, and punctuation", () => {
  assert.equal(
    normalizeQuestionKey("4. In project management, what is considered a best practice for managing project risks? 1 point"),
    "in project management, what is considered a best practice for managing project risks?"
  );
  assert.equal(
    normalizeQuestionKey("Question 5: Why is it important to engage with stakeholders early in the project? (1 point)"),
    "why is it important to engage with stakeholders early in the project?"
  );
  assert.equal(
    normalizeQuestionKey("1) What is Agile? 2 / 2 points"),
    "what is agile?"
  );
});

test("normalizeOptionText and isOptionMatching match options with leading markers and minor differences", () => {
  const opt1 = "A. Conducting a thorough risk assessment at the beginning of the project";
  const opt2 = "conducting a thorough risk assessment at the beginning of the project.";
  assert.equal(isOptionMatching(opt1, opt2), true);

  const opt3 = "To minimize stakeholders' involvement and block their influence on project outcomes.";
  const opt4 = "To minimize stakeholders' involvement and block their influence on project outcomes";
  assert.equal(isOptionMatching(opt3, opt4), true);
  assert.equal(isOptionMatching("Option X", "Option Y"), false);
});

test("extractPointsFromText and classifyReviewStatus parse scores and status", () => {
  assert.deepEqual(extractPointsFromText("1 / 1 point"), { earned: 1, total: 1 });
  assert.deepEqual(extractPointsFromText("0 / 1 pt"), { earned: 0, total: 1 });
  assert.deepEqual(extractPointsFromText("0.5 of 1 points"), { earned: 0.5, total: 1 });
  assert.equal(extractPointsFromText("No points here"), null);

  assert.equal(classifyReviewStatus("", 1, 1), "correct");
  assert.equal(classifyReviewStatus("", 0, 1), "incorrect");
  assert.equal(classifyReviewStatus("", 0.5, 1), "partially_correct");
  assert.equal(classifyReviewStatus("Correct", null, null), "correct");
  assert.equal(classifyReviewStatus("Incorrect", null, null), "incorrect");
});

test("mergeQuestionMemory tracks wrong attempts, isolates wrong single-choice options, and saves confirmed correct options", () => {
  const initial = mergeQuestionMemory(null, {
    prompt: "4. In project management, what is a best practice? 1 point",
    type: "single_choice",
    chosenOptions: ["Assigning blame to team members"],
    status: "incorrect",
    feedback: "Incorrect",
  });

  assert.equal(initial.knownWrongOptions.length, 1);
  assert.equal(initial.knownWrongOptions[0], "Assigning blame to team members");
  assert.equal(initial.wrongAttempts.length, 1);
  assert.equal(initial.confirmedCorrectOptions.length, 0);

  // Attempt 2: Got correct answer
  const updated = mergeQuestionMemory(initial, {
    prompt: "In project management, what is a best practice?",
    type: "single_choice",
    chosenOptions: ["Conducting a thorough risk assessment"],
    status: "correct",
  });

  assert.equal(updated.knownWrongOptions.length, 1);
  assert.equal(updated.confirmedCorrectOptions.length, 1);
  assert.equal(updated.confirmedCorrectOptions[0], "Conducting a thorough risk assessment");

  const promptText = formatMemoryForPrompt(updated);
  assert.match(promptText, /CONFIRMED CORRECT ANSWER/);
  assert.match(promptText, /CONFIRMED WRONG OPTION/);
});

test("mergeQuestionMemory tracks specific wrong options from Coursera feedback even for multi-select questions", () => {
  const memory = mergeQuestionMemory(null, {
    prompt: "2. What are the key responsibilities of a Business Analyst? Select all that apply. 0 / 1 point",
    type: "multi_select",
    hasCheckbox: true,
    chosenOptions: ["Managing the company's social media accounts and online presence."],
    specificWrongOptions: ["Managing the company's social media accounts and online presence."],
    status: "incorrect",
    feedback: "Not quite.",
  });

  assert.equal(memory.knownWrongOptions.length, 1);
  assert.equal(memory.knownWrongOptions[0], "Managing the company's social media accounts and online presence.");
  assert.equal(memory.wrongAttempts.length, 1);

  const formatted = formatMemoryForPrompt(memory);
  assert.match(formatted, /CRITICAL - DO NOT SELECT THESE CONFIRMED WRONG OPTION\(S\)/);
  assert.match(formatted, /Managing the company's social media accounts/);
});

test("mergeQuestionMemory handles null, undefined, or empty newReview without throwing", () => {
  assert.equal(mergeQuestionMemory(null, null), null);
  assert.equal(mergeQuestionMemory(null, undefined), null);
  const existing = { prompt: "Test question", fingerprint: "test_question", confirmedCorrectOptions: [] };
  const mergedWithNull = mergeQuestionMemory(existing, null);
  assert.equal(mergedWithNull.prompt, "Test question");
  const mergedWithEmpty = mergeQuestionMemory(existing, {});
  assert.equal(mergedWithEmpty.prompt, "Test question");
});

test("isRetryActionLabel recognizes retry buttons on Coursera", () => {
  assert.equal(isRetryActionLabel("Retry"), true);
  assert.equal(isRetryActionLabel("↻ Retry"), true);
  assert.equal(isRetryActionLabel("Try again"), true);
  assert.equal(isRetryActionLabel("Retake"), true);
  assert.equal(isRetryActionLabel("Take again"), true);
  assert.equal(isRetryActionLabel("Start next attempt"), true);
  assert.equal(isRetryActionLabel("Submit"), false);
  assert.equal(isRetryActionLabel("Continue"), false);
});

test("normalizeVisionDecision handles valid actions and defaults invalid ones", () => {
  assert.deepEqual(
    normalizeVisionDecision({ action: "CLICK", targetText: " Continue " }),
    { action: "click", targetText: "Continue", targetSelector: "", reason: "" }
  );

  assert.deepEqual(
    normalizeVisionDecision({ action: "unknown_action", buttonText: "Start" }),
    { action: "none", targetText: "Start", targetSelector: "", reason: "" }
  );

  assert.deepEqual(
    normalizeVisionDecision(null),
    { action: "none", targetText: "", targetSelector: "", reason: "" }
  );
});

test("isMatchingClickableText matches text with punctuation or minor variations", () => {
  assert.equal(isMatchingClickableText("Continue", "Continue"), true);
  assert.equal(isMatchingClickableText("Continue to Attempt", "Continue"), true);
  assert.equal(isMatchingClickableText("Start Quiz", "Start"), true);
  assert.equal(isMatchingClickableText("Cancel", "Continue"), false);
});

test("describeRunnerLogEntry formats vision and essay screenshot events", () => {
  assert.match(
    describeRunnerLogEntry({
      eventName: "quiz_essay_screenshot_captured",
      details: { textQuestionCount: 2 },
    }),
    /Chụp ảnh màn hình cho câu hỏi tự luận/
  );

  assert.match(
    describeRunnerLogEntry({
      eventName: "quiz_vision_decision_received",
      details: { action: "click", targetText: "Continue", reason: "Modal is open" },
    }),
    /AI Vision.*Continue/
  );

  assert.match(
    describeRunnerLogEntry({
      eventName: "quiz_vision_action_clicked",
      details: { targetText: "Continue" },
    }),
    /AI Vision tự động bấm: "Continue"/
  );

  assert.match(
    describeRunnerLogEntry({
      eventName: "quiz_submit_blocked_by_quality_gate",
      details: { unansweredCount: 2 },
    }),
    /Chặn submit.*2 câu/
  );

  assert.match(
    describeRunnerLogEntry({
      eventName: "quiz_confirm_blocked_unanswered_in_dialog",
    }),
    /Hủy popup submit/
  );

  assert.match(
    describeRunnerLogEntry({
      eventName: "quiz_quality_gate_passed",
      details: { totalQuestions: 5 },
    }),
    /toàn bộ 5 câu hỏi đã được điền/
  );
});

test("isCancelActionLabel identifies cancel and return buttons", () => {
  assert.equal(isCancelActionLabel("Cancel"), true);
  assert.equal(isCancelActionLabel("Back"), true);
  assert.equal(isCancelActionLabel("Return to quiz"), true);
  assert.equal(isCancelActionLabel("Dismiss"), true);
  assert.equal(isCancelActionLabel("Submit"), false);
});

test("isUnansweredNoticeText detects validation error warnings", () => {
  assert.equal(isUnansweredNoticeText("Please answer all questions before submitting"), true);
  assert.equal(isUnansweredNoticeText("You have 2 unanswered questions"), true);
  assert.equal(isUnansweredNoticeText("This question requires an answer"), true);
  assert.equal(isUnansweredNoticeText("Invalid response"), true);
  assert.equal(isUnansweredNoticeText("Congratulations, you passed!"), false);
});

test("isSubmitConfirmDialogBlocked identifies dialog warnings about unanswered questions", () => {
  assert.equal(isSubmitConfirmDialogBlocked("Are you sure you want to submit? You have 1 unanswered question."), true);
  assert.equal(isSubmitConfirmDialogBlocked("Not all questions have been answered. Submit anyway?"), true);
  assert.equal(isSubmitConfirmDialogBlocked("Are you sure you want to submit your assignment?"), false);
});

test("checkQuizSubmissionQualityGates enforces 100% question completion and clean validation state", () => {
  // Case 1: All answered, no errors -> canSubmit = true
  const passResult = checkQuizSubmissionQualityGates({
    questions: [
      { isAnswered: true },
      { chosenIndexes: [1] },
      { content: "Essay answer" },
    ],
    pageErrors: [],
  });
  assert.equal(passResult.canSubmit, true);
  assert.equal(passResult.unansweredIndexes.length, 0);

  // Case 2: One unanswered question -> canSubmit = false
  const failResult = checkQuizSubmissionQualityGates({
    questions: [
      { isAnswered: true },
      { chosenIndexes: [] }, // missing answer!
      { content: "Essay answer" },
    ],
    pageErrors: [],
  });
  assert.equal(failResult.canSubmit, false);
  assert.deepEqual(failResult.unansweredIndexes, [1]);
  assert.match(failResult.reason, /1 unanswered question/);

  // Case 3: Page has validation errors -> canSubmit = false
  const errorResult = checkQuizSubmissionQualityGates({
    questions: [{ isAnswered: true }],
    pageErrors: ["Please answer all questions before submitting"],
  });
  assert.equal(errorResult.canSubmit, false);
  assert.match(errorResult.reason, /Validation error/);

  // Case 4: Confirmation dialog warning about incomplete answers -> canSubmit = false
  const dialogResult = checkQuizSubmissionQualityGates({
    questions: [{ isAnswered: true }],
    dialogText: "You have 1 unanswered question.",
  });
  assert.equal(dialogResult.canSubmit, false);
  assert.match(dialogResult.reason, /unanswered questions/);
});

test("extractGradePercentage parses percentages and fractions from diverse Coursera text formats", () => {
  assert.equal(extractGradePercentage("Activity: Identifying risksPractice AssignmentGrade: 0%"), 0);
  assert.equal(extractGradePercentage("Practice Quiz: TypesPractice AssignmentGrade: 100%"), 100);
  assert.equal(extractGradePercentage("Practice AssignmentGrade: 16.66%"), 16.66);
  assert.equal(extractGradePercentage("Grade: 75%"), 75);
  assert.equal(extractGradePercentage("Your grade: 0%"), 0);
  assert.equal(extractGradePercentage("Your grade: 85%"), 85);
  assert.equal(extractGradePercentage("Highest score: 70%"), 70);
  assert.equal(extractGradePercentage("Grade received: 92.5%"), 92.5);
  assert.equal(extractGradePercentage("Grade: 4/10"), 40);
  assert.equal(extractGradePercentage("Grade: 0"), 0);
  assert.equal(extractGradePercentage("No grade here"), null);
});

test("extractPassingThreshold extracts threshold from text or returns default 80", () => {
  assert.equal(extractPassingThreshold("To pass: 80%"), 80);
  assert.equal(extractPassingThreshold("Passing grade: 70%"), 70);
  assert.equal(extractPassingThreshold("Minimum passing score: 75%"), 75);
  assert.equal(extractPassingThreshold("Some assignment with no threshold text"), 80);
});

test("inferSidebarCompletionSignals rejects quizzes with failing grades (< 80%) so they will be retried", () => {
  // Real user log case: Activity: Identifying risksPractice AssignmentGrade: 0%
  assert.equal(
    inferSidebarCompletionSignals({
      ariaLabel: "Practice Assignment, Activity: Identifying risks, Completed, Grade: 0%",
      text: "Activity: Identifying risksPractice AssignmentGrade: 0%",
      hasSuccessIcon: false,
    }),
    false,
    "Grade: 0% must be marked as false (incomplete) so the runner retries it"
  );

  // Grade: 16.66%
  assert.equal(
    inferSidebarCompletionSignals({
      ariaLabel: "Practice AssignmentGrade: 16.66%",
      text: "Practice AssignmentGrade: 16.66%",
      hasSuccessIcon: false,
    }),
    false,
    "Grade: 16.66% is below 80% passing threshold and must be retried"
  );

  // Grade: 79% (below default 80%)
  assert.equal(
    inferSidebarCompletionSignals({
      text: "Module Quiz Grade: 79%",
    }),
    false
  );

  // Explicit unpassed words
  assert.equal(
    inferSidebarCompletionSignals({
      text: "Try again. You did not pass.",
    }),
    false
  );
});

test("inferSidebarCompletionSignals approves quizzes with passing grades (>= 80%)", () => {
  // Grade: 100%
  assert.equal(
    inferSidebarCompletionSignals({
      ariaLabel: "Practice Quiz: Types, Completed, Grade: 100%",
      text: "Practice Quiz: TypesPractice AssignmentGrade: 100%",
      hasSuccessIcon: true,
    }),
    true
  );

  // Grade: 80%
  assert.equal(
    inferSidebarCompletionSignals({
      text: "Knowledge Check Grade: 80%",
    }),
    true
  );

  // Dynamic threshold: 70% required and 70% achieved
  assert.equal(
    inferSidebarCompletionSignals({
      text: "Practice Quiz Grade: 70% (To pass: 70%)",
    }),
    true
  );

  // Dynamic threshold: 80% required and 70% achieved -> false
  assert.equal(
    inferSidebarCompletionSignals({
      text: "Practice Quiz Grade: 70% (To pass: 80%)",
    }),
    false
  );
});

test("classifyQuizStateText handles attempt scores with passing threshold", () => {
  // Score 16.66% is failed
  assert.equal(
    classifyQuizStateText("Your grade: 16.66% To pass: 80%"),
    "failed"
  );

  // Score 0% is failed
  assert.equal(
    classifyQuizStateText("Your grade: 0%"),
    "failed"
  );

  // Score 85% is passed
  assert.equal(
    classifyQuizStateText("Your grade: 85%"),
    "passed"
  );

  // Grade received: 100% is passed
  assert.equal(
    classifyQuizStateText("Grade received: 100%"),
    "passed"
  );
});

test("shouldTreatExistingAttemptAsPassed respects passing threshold and rejects failing scores", () => {
  assert.equal(
    shouldTreatExistingAttemptAsPassed({
      quizState: "passed",
      hasNextButton: true,
      startLabel: "",
      pageText: "Your grade: 0% To pass 80%",
    }),
    false
  );

  assert.equal(
    shouldTreatExistingAttemptAsPassed({
      quizState: "passed",
      hasNextButton: true,
      startLabel: "",
      pageText: "Your grade: 75% To pass 80%",
    }),
    false
  );

  assert.equal(
    shouldTreatExistingAttemptAsPassed({
      quizState: "passed",
      hasNextButton: true,
      startLabel: "",
      pageText: "Your grade: 85%",
    }),
    true
  );
});

test("describeRunnerLogEntry formats retry_quiz decision for failed quizzes", () => {
  assert.equal(
    describeRunnerLogEntry({
      eventName: "quiz_scan_item",
      details: {
        title: "Activity: Identifying risks",
        decision: "retry_quiz",
      },
    }),
    'Đọc "Activity: Identifying risks" => làm lại quiz (chưa đạt điểm)'
  );
});

test("isSameOptionCombination detects identical option sets regardless of order and formatting", () => {
  assert.equal(
    isSameOptionCombination(["Option A", "Option B"], ["option b", "option a"]),
    true
  );
  assert.equal(
    isSameOptionCombination(["1. Option A", "2. Option B"], ["A. Option A", "B. Option B"]),
    true
  );
  assert.equal(
    isSameOptionCombination(["Option A"], ["Option B"]),
    false
  );
  assert.equal(
    isSameOptionCombination(["Option A", "Option B"], ["Option A"]),
    false
  );
});

test("recordQuizAttemptHistory tracks attempts with scores, timestamps, and caps at 10", () => {
  let attempts = [];
  attempts = recordQuizAttemptHistory(attempts, {
    scorePercent: 60,
    passingThreshold: 80,
    finalState: "failed",
    questions: [
      { prompt: "Q1", chosenOptions: ["A"], status: "incorrect" },
    ],
  });

  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].attemptNumber, 1);
  assert.equal(attempts[0].scorePercent, 60);
  assert.equal(attempts[0].finalState, "failed");

  attempts = recordQuizAttemptHistory(attempts, {
    scorePercent: 85,
    passingThreshold: 80,
    finalState: "passed",
    questions: [
      { prompt: "Q1", chosenOptions: ["B"], status: "correct" },
    ],
  });

  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].attemptNumber, 2);
  assert.equal(attempts[1].scorePercent, 85);
  assert.equal(attempts[1].finalState, "passed");

  // Verify capping at 10 items
  for (let i = 3; i <= 15; i++) {
    attempts = recordQuizAttemptHistory(attempts, { scorePercent: 70 });
  }
  assert.equal(attempts.length, 10);
});

test("buildPreviousAttemptReport creates structured previous attempt summary for AI prompt", () => {
  const attempts = [
    {
      attemptNumber: 1,
      scorePercent: 60,
      gradeText: "60%",
      passingThreshold: 80,
      finalState: "failed",
      questions: [
        {
          prompt: "What is Agile?",
          type: "single_choice",
          chosenOptions: ["Waterfall variant"],
          status: "incorrect",
          pointsEarned: 0,
          pointsTotal: 1,
          feedback: "Incorrect option",
        },
        {
          prompt: "Select Scrum ceremonies",
          type: "multi_select",
          chosenOptions: ["Daily Standup", "Sprint Review"],
          status: "correct",
          pointsEarned: 1,
          pointsTotal: 1,
        },
      ],
    },
  ];

  const report = buildPreviousAttemptReport(attempts, { title: "Agile Quiz" });
  assert.ok(report);
  assert.equal(report.attemptNumber, 1);
  assert.equal(report.previousScore, "60%");
  assert.equal(report.passingThreshold, "80%");
  assert.equal(report.status, "failed");
  assert.ok(report.summaryInstruction.includes("scored 60%"));
  assert.ok(report.summaryInstruction.includes("FAILED"));
  assert.equal(report.submittedQuestions.length, 2);
  assert.equal(report.submittedQuestions[0].resultStatus, "incorrect");
  assert.equal(report.submittedQuestions[1].resultStatus, "correct");

  // Empty attempts returns null
  assert.equal(buildPreviousAttemptReport([]), null);
  assert.equal(buildPreviousAttemptReport(null), null);
});

test("formatQuestionPreviousAttempt formats targeted guidance for AI prompt", () => {
  const correctQ = {
    chosenOptions: ["Option A"],
    status: "correct",
  };
  const correctText = formatQuestionPreviousAttempt(correctQ, 70, 80);
  assert.ok(correctText.includes("STATUS: CORRECT"));
  assert.ok(correctText.includes("RETAIN AND SELECT THIS ANSWER"));

  const incorrectQ = {
    chosenOptions: ["Option B"],
    status: "incorrect",
  };
  const incorrectText = formatQuestionPreviousAttempt(incorrectQ, 60, 80);
  assert.ok(incorrectText.includes("STATUS: INCORRECT"));
  assert.ok(incorrectText.includes("CRITICAL: DO NOT SELECT"));

  const unpassedQ = {
    chosenOptions: ["Option C"],
    status: "unpassed",
  };
  const unpassedText = formatQuestionPreviousAttempt(unpassedQ, 60, 80);
  assert.ok(unpassedText.includes("failed quiz attempt (< 80%)"));
});

test("mergeQuestionMemory handles unpassed_attempt without falsely banning correct options", () => {
  const initial = mergeQuestionMemory(null, {
    prompt: "Key question",
    chosenOptions: ["Option A"],
    status: "unpassed_attempt",
    type: "single_choice",
  });

  // Should NOT be added to knownWrongOptions because the question itself might have been correct
  assert.deepEqual(initial.knownWrongOptions, []);
  assert.equal(initial.unpassedAttempts.length, 1);
  assert.deepEqual(initial.unpassedAttempts[0].options, ["Option A"]);
});

test("describeRunnerLogEntry formats attempt and memory events in Vietnamese", () => {
  assert.equal(
    describeRunnerLogEntry({
      eventName: "quiz_retry_attempt",
      details: { attemptNumber: 2, maxRetries: 2, previousScore: "60%" },
    }),
    "Làm lại quiz lần 2/3 (lần trước: 60%)"
  );
  assert.equal(
    describeRunnerLogEntry({
      eventName: "quiz_loop_detected_altering_combination",
    }),
    "Phát hiện tổ hợp từng bị 0 điểm, tự động đổi phương án khác để tránh lặp"
  );
  assert.equal(
    describeRunnerLogEntry({
      eventName: "quiz_previous_attempt_attached",
      details: { previousScore: "60%" },
    }),
    "Đính kèm kết quả lần trước (60%) và toàn bộ đáp án cũ vào AI"
  );
});

test("isContinueActionLabel recognizes next item and arrow labels", () => {
  assert.equal(isContinueActionLabel("Next item"), true);
  assert.equal(isContinueActionLabel("Next item →"), true);
  assert.equal(isContinueActionLabel("Next item ->"), true);
  assert.equal(isContinueActionLabel("→ Next item"), true);
  assert.equal(isContinueActionLabel("Next lesson"), true);
  assert.equal(isContinueActionLabel("Next module"), true);
});

test("classifyQuizStateText and shouldTreatExistingAttemptAsPassed correctly handle view-feedback 100% grade banner", () => {
  const feedbackPageText =
    "Your grade: 100% Your latest: 100% • Your highest: 100% • To pass you need at least 80%. We keep your highest score. Next item -> 1. A service business owner... Nice work";

  assert.equal(classifyQuizStateText(feedbackPageText), "passed");

  // Should pass even if the page text mentions 'incorrect' in feedback options or questions
  const feedbackWithIncorrect =
    "Your grade: 100% Filter by: All / Correct / Incorrect answers. Retake policy: none.";
  assert.equal(classifyQuizStateText(feedbackWithIncorrect), "passed");

  assert.equal(
    shouldTreatExistingAttemptAsPassed({
      quizState: "passed",
      hasNextButton: true,
      startLabel: "",
      pageText: feedbackPageText,
      passingThreshold: 80,
    }),
    true
  );
});

test("formatQuestionPreviousAttempt and formatMemoryForPrompt attach Coursera feedback/hints to AI prompt", () => {
  const reviewedQ = {
    prompt: "Why has this text appeared in the cell?",
    type: "single_choice",
    chosenOptions: ["The number format is incorrect."],
    status: "incorrect",
    feedback: "Not quite. The number should initially be recognized with the General format.",
  };

  const mem = mergeQuestionMemory(null, reviewedQ);
  assert.equal(mem.lastFeedback, "Not quite. The number should initially be recognized with the General format.");
  assert.ok(mem.feedbacks.includes("Not quite. The number should initially be recognized with the General format."));

  const promptText = formatQuestionPreviousAttempt(reviewedQ, 20, 80);
  assert.ok(promptText.includes('COURSERA FEEDBACK / EXPLANATION: "Not quite. The number should initially be recognized with the General format."'));
  assert.ok(promptText.includes("CRITICAL: Read this explanation carefully"));

  const memoryPrompt = formatMemoryForPrompt(mem);
  assert.ok(memoryPrompt.includes('Coursera feedback: "Not quite. The number should initially be recognized with the General format."'));
  assert.ok(memoryPrompt.includes("COURSERA EXPLANATIONS / HINTS FROM PREVIOUS ATTEMPTS"));
});

test("isQuizAttemptLocked detects 24h lockout, 0 attempts remaining, and disabled retry button", () => {
  // Real screenshot scenario:
  // "0 of 1 attempt every 24 hours" and disabled "Try again" button
  const userScreenshotText =
    "Module Quiz: Excel Fundamentals Try again Help me practice You didn't pass. To pass you need a grade of at least 80%. 40% View feedback What to expect Due Oct 22, 11:59 PM +07 0 of 1 attempt every 24 hours 30 min per attempt";

  assert.equal(
    isQuizAttemptLocked({
      pageText: userScreenshotText,
      hasRetryButton: true,
      retryButtonDisabled: true,
      hasEnabledStartButton: false,
    }),
    true,
    "Should identify quiz as locked when 0 of 1 attempt every 24 hours and retry is disabled"
  );

  // Text says 0 of 3 attempts every 8 hours
  assert.equal(
    isQuizAttemptLocked({
      pageText: "You have 0 of 3 attempts every 8 hours.",
      hasRetryButton: true,
      retryButtonDisabled: true,
    }),
    true
  );

  // Text says 0 attempts remaining
  assert.equal(
    isQuizAttemptLocked({
      pageText: "0 attempts remaining. Next attempt available in 23 hours.",
      hasRetryButton: false,
    }),
    true
  );

  // Vietnamese lockout text
  assert.equal(
    isQuizAttemptLocked({
      pageText: "Bạn đã hết lượt làm bài. 0 trên 1 lần thử. Thử lại sau 24 giờ.",
    }),
    true
  );

  // Retry button is disabled even with minimal text
  assert.equal(
    isQuizAttemptLocked({
      pageText: "You didn't pass. Grade: 40%.",
      hasRetryButton: true,
      retryButtonDisabled: true,
    }),
    true
  );

  // Retry button is enabled -> NOT locked (user can try again!)
  assert.equal(
    isQuizAttemptLocked({
      pageText: userScreenshotText,
      hasRetryButton: true,
      retryButtonDisabled: false,
      hasEnabledStartButton: false,
    }),
    false,
    "Enabled retry button should NOT be considered locked"
  );

  // Enabled start button exists -> NOT locked
  assert.equal(
    isQuizAttemptLocked({
      pageText: "Start attempt",
      hasRetryButton: true,
      retryButtonDisabled: true,
      hasEnabledStartButton: true,
    }),
    false
  );
});

test("isRetryActionLabel recognizes Vietnamese and English retry buttons", () => {
  assert.equal(isRetryActionLabel("Try again"), true);
  assert.equal(isRetryActionLabel("Retry"), true);
  assert.equal(isRetryActionLabel("Retake quiz"), true);
  assert.equal(isRetryActionLabel("Làm lại"), true);
  assert.equal(isRetryActionLabel("Thử lại"), true);
  assert.equal(isRetryActionLabel("View feedback"), false);
  assert.equal(isRetryActionLabel("Back"), false);
});

test("describeRunnerLogEntry formats feedback inspected, back clicked, and attempt locked events", () => {
  const inspectedEntry = {
    eventName: "quiz_feedback_inspected",
    details: { questionCount: 5 },
  };
  assert.ok(describeRunnerLogEntry(inspectedEntry).includes("5 câu"));

  const backEntry = {
    eventName: "quiz_feedback_back_clicked",
  };
  assert.ok(describeRunnerLogEntry(backEntry).includes("Quay lại màn hình tổng kết"));

  const lockedEntry = {
    eventName: "quiz_attempt_locked",
    details: { reason: "Try again is disabled (24-hour limit)" },
  };
  assert.ok(describeRunnerLogEntry(lockedEntry).includes("khóa lượt làm"));
});
test("extractPointsFromText distinguishes math fractions and dates from real points", () => {
  // Math fraction without point suffix should NOT match
  assert.equal(extractPointsFromText("Which formula returns 1/2 in Excel?"), null);
  assert.equal(extractPointsFromText("Date: 10/5/2023"), null);

  // Real point strings with point/pts/điểm suffix
  assert.deepEqual(extractPointsFromText("1 / 1 point"), { earned: 1, total: 1 });
  assert.deepEqual(extractPointsFromText("0/1 point"), { earned: 0, total: 1 });
  assert.deepEqual(extractPointsFromText("0.5 / 1 pts"), { earned: 0.5, total: 1 });
  assert.deepEqual(extractPointsFromText("10 of 10 points"), { earned: 10, total: 10 });
  assert.deepEqual(extractPointsFromText("Which formula returns 1/2 in Excel? 0/1 point"), { earned: 0, total: 1 });
});

test("mergeQuestionMemory purges incorrect chosen options from confirmedCorrectOptions and sanitizes memory", () => {
  // Scenario: A question previously had a bogus confirmedCorrectOption due to false positive
  const existingMemory = {
    prompt: "What is an absolute reference?",
    type: "single_choice",
    confirmedCorrectOptions: ["A1"], // Wrongly saved previously
    knownWrongOptions: [],
    wrongAttempts: [],
    revealedAnswer: "A1",
  };

  const newReview = {
    prompt: "What is an absolute reference?",
    type: "single_choice",
    chosenOptions: ["A1"],
    status: "incorrect",
    feedback: "Incorrect. An absolute reference contains dollar signs like $A$1.",
  };

  const updated = mergeQuestionMemory(existingMemory, newReview);

  // 'A1' MUST be purged from confirmedCorrectOptions and revealedAnswer!
  assert.deepEqual(updated.confirmedCorrectOptions, []);
  assert.equal(updated.revealedAnswer, "");
  // 'A1' MUST be added to knownWrongOptions
  assert.ok(updated.knownWrongOptions.includes("A1"));
  // wrongAttempts must be recorded
  assert.equal(updated.wrongAttempts.length, 1);
  assert.deepEqual(updated.wrongAttempts[0].options, ["A1"]);
});

test("matchesItemPath and isPathSkipped correctly handle assignment-submission subpath slug URLs", () => {
  const browserUrl =
    "/learn/data-and-business-process-modeling-with-microsoft-visio/assignment-submission/Fa0r2/activity-create-a-basic-diagram";
  const apiItemPath =
    "/learn/data-and-business-process-modeling-with-microsoft-visio/assignment-submission/Fa0r2";
  const differentItemPath =
    "/learn/data-and-business-process-modeling-with-microsoft-visio/assignment-submission/Zy9x8";

  // 1. Matches item despite appended title slug from Coursera SPA router
  assert.equal(matchesItemPath(browserUrl, apiItemPath), true);
  assert.equal(matchesItemPath(apiItemPath, browserUrl), true);
  assert.equal(matchesItemPath(browserUrl, differentItemPath), false);

  // 2. Extracts course slug and item id
  assert.equal(
    extractCourseSlug(browserUrl),
    "data-and-business-process-modeling-with-microsoft-visio"
  );
  assert.equal(extractItemId(browserUrl), "Fa0r2");
  assert.equal(extractItemId(apiItemPath), "Fa0r2");

  // 3. isPathSkipped matches both browser slug URL and API item path
  const skippedSet = new Set([browserUrl]);
  assert.equal(isPathSkipped(skippedSet, apiItemPath), true);
  assert.equal(isPathSkipped(skippedSet, browserUrl), true);
  assert.equal(isPathSkipped(skippedSet, differentItemPath), false);

  // 4. pickFirstIncomplete skips item even if skippedSet has browser URL with slug
  const items = [
    { path: apiItemPath, title: "Activity: Create a basic diagram", type: "quiz" },
    { path: differentItemPath, title: "Next Quiz", type: "quiz" },
  ];
  const completionMap = new Map();
  const nextItem = pickFirstIncompleteQuiz(items, completionMap, skippedSet);
  assert.deepEqual(nextItem, items[1]);
});

test("isContinueActionLabel recognizes Vietnamese navigation buttons", () => {
  assert.equal(isContinueActionLabel("Tiếp tục"), true);
  assert.equal(isContinueActionLabel("Mục tiếp theo"), true);
  assert.equal(isContinueActionLabel("Tiếp theo"), true);
});

test("classifyQuizStateText treats 'Start assignment' cover page as pending", () => {
  const cover =
    "Practice Assignment Activity: Add media to a diagram Start assignment Help me practice This is a practice assignment";
  assert.equal(classifyQuizStateText(cover), "pending");
  assert.equal(isStartActionLabel("Start assignment"), true);
  assert.equal(
    shouldTreatExistingAttemptAsPassed({
      quizState: "passed",
      hasNextButton: true,
      startLabel: "",
      pageText: cover + " Congratulations",
    }),
    false
  );
});

test("isStartActionLabel accepts start/resume assignment and rejects menu/outline/navigation", () => {
  assert.equal(isStartActionLabel("Start assignment"), true);
  assert.equal(isStartActionLabel("Resume assignment"), true);
  assert.equal(isStartActionLabel("Start quiz"), true);
  assert.equal(isStartActionLabel("Resume quiz"), true);
  assert.equal(isStartActionLabel("Take quiz"), true);
  assert.equal(isStartActionLabel("Bắt đầu"), true);
  assert.equal(isStartActionLabel("Làm bài"), true);

  // Must reject header/navigation buttons that start with Open
  assert.equal(isStartActionLabel("Open navigation menu"), false);
  assert.equal(isStartActionLabel("Open course outline"), false);
  assert.equal(isStartActionLabel("Open menu"), false);
  assert.equal(isStartActionLabel("Search"), false);
  assert.equal(isStartActionLabel("Notifications"), false);
  assert.equal(isStartActionLabel("Cancel"), false);
  assert.equal(isStartActionLabel("Next"), false);
});

test("isPeerAssignmentSubmitted rejects unsubmitted form even if header tabs contain 'Peers to review'", () => {
  const peerPageWithTabs =
    "Practice Graded Assignment: Initiating a Data Science Project Instructions My submission Peers to review Discussions Project Title Enter text here Save draft Submit";

  // When on submit page with submission inputs and submit action: MUST BE FALSE
  assert.equal(
    isPeerAssignmentSubmitted({
      isPeerItem: true,
      isSubmitUrl: true,
      hasSubmissionInputs: true,
      hasSubmitAction: true,
      pageText: peerPageWithTabs,
      justSubmitted: false,
    }),
    false
  );

  // When just submitted: MUST BE TRUE
  assert.equal(
    isPeerAssignmentSubmitted({
      isPeerItem: true,
      isSubmitUrl: true,
      hasSubmissionInputs: false,
      hasSubmitAction: false,
      pageText: peerPageWithTabs + " You've submitted your assignment",
      justSubmitted: true,
    }),
    true
  );

  // When on cover page with 'You've submitted' banner: MUST BE TRUE
  assert.equal(
    isPeerAssignmentSubmitted({
      isPeerItem: true,
      isSubmitUrl: false,
      hasSubmissionInputs: false,
      hasSubmitAction: false,
      pageText: "Initiating a Data Science Project You have submitted your assignment. Review 3 peers to get your grade.",
      justSubmitted: false,
    }),
    true
  );
});

test("isUnansweredNoticeText detects answer length requirement notices", () => {
  assert.equal(
    isUnansweredNoticeText(
      "Your answer needs to be a little bit longer. Write a few sentences to complete your assignment."
    ),
    true
  );
  assert.equal(isUnansweredNoticeText("Write a few sentences"), true);
  assert.equal(isUnansweredNoticeText("Câu trả lời quá ngắn"), true);
});

test("isTextQuestionAnswered validates text questions and titles properly", () => {
  // Empty or whitespace
  assert.equal(isTextQuestionAnswered({ text: "" }), false);
  assert.equal(isTextQuestionAnswered({ text: "   " }), false);

  // Coursera placeholder text
  assert.equal(isTextQuestionAnswered({ text: "Enter text here" }), false);
  assert.equal(isTextQuestionAnswered({ text: "type your response" }), false);
  assert.equal(isTextQuestionAnswered({ text: "viết câu trả lời" }), false);

  // Short response (< 50 chars) for essay
  assert.equal(isTextQuestionAnswered({ text: "Data science is analysis." }), false);

  // Title accepts short non-empty string
  assert.equal(isTextQuestionAnswered({ isTitle: true, text: "GCNB Customer Adoption" }), true);
  assert.equal(isTextQuestionAnswered({ isTitle: true, text: "" }), false);

  // Essay response (> 50 chars)
  const goodAnswer =
    "Data science is an interdisciplinary field combining statistical analysis, data engineering, and domain knowledge to extract actionable business insights.";
  assert.equal(isTextQuestionAnswered({ isTitle: false, text: goodAnswer }), true);

  // Container still showing 'needs to be a little bit longer' notice
  assert.equal(
    isTextQuestionAnswered({
      isTitle: false,
      text: goodAnswer,
      containerNotice: "Your answer needs to be a little bit longer. Write a few sentences to complete your assignment.",
    }),
    false
  );
});



