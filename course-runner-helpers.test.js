const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCourseMaterialsUrl,
  buildRunnerLogEntry,
  buildRunnerLogMessage,
  classifyQuizStateText,
  describeRunnerLogEntry,
  flattenCourseStructure,
  formatRunnerLogExport,
  inferSidebarCompletionSignals,
  isContinueActionLabel,
  isEligibleQuizItem,
  isEligibleQuizRunItem,
  isStartActionLabel,
  isSubmitActionLabel,
  isUngradedAppItem,
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
  assert.equal(isStartActionLabel("Begin"), true);
  assert.equal(isStartActionLabel("Continue"), false);
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
