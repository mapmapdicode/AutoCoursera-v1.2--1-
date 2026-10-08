const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const helpers = require("./course-runner-helpers");

function harness({reply, kind = "limited", memory = {}} = {}) {
    const source = fs.readFileSync("./course-runner.js", "utf8");
    const start = source.indexOf("    async function createQuizAnswerProvider(");
    const end = source.indexOf("    function summarizeItem(", start);
    const calls = [], fills = [];
    const question = {type: "text", question: "Explain", inputElement: {value: ""}};
    class AI {
        async readSettings() {return {aiMode: "chatgpt_web"};}
        async solveQuestions(prompt, options) {calls.push({prompt, options}); if (reply instanceof Error) throw reply; return reply;}
        async solveQuestionsViaLuna() {throw new Error("Luna must not override web mode");}
    }
    const context = {window: {GeminiAI: AI, ChatGPTPolicy: {currentPolicy: () => ({kind, mode: kind === "unlimited" ? "fast" : "pro"})}},
        helpers: {...helpers, copyRenderedQuestionText: () => "Explain the concept"}, CourseRunnerHelpers: helpers,
        storageGet: async () => ({lunaAutofillEnabled: true}), location: {pathname: "/learn/c/quiz/a/attempt"},
        normalizePath: helpers.normalizePath, getItemSlug: helpers.getItemSlug, getRunState: async () => ({active: true}),
        ensureAllQuizContentScrolledAndLoaded: async () => {}, extractQuizQuestionsFromDom: () => [question],
        deriveCourseSlug: () => "c", loadCourseQuizMemory: async () => ({questions: memory, quizAttempts: {}}),
        extractAssignmentScenarioContext: () => "", logRunner() {}, logRunnerWarn() {}, summarizeItem: () => ({}),
        fillTextInput: async (input, text) => {fills.push(text); input.value = text;},
        validateQuestionElementAnswered: (q) => Boolean(q.inputElement?.value), delay: async () => {},
        captureQuestionSections: async () => {throw new Error("Should not capture an image for provider errors");},
        generateFallbackTextAnswer: () => "Invented fallback answer which must never be filled", sessionStorage: {setItem() {}},
    };
    vm.createContext(context); vm.runInContext(source.slice(start, end) + "\nthis.solve = solveQuizDirectlyFromDom; this.provider = createQuizAnswerProvider;", context);
    return {context, calls, fills, question};
}
test("ChatGPT provider overrides a saved Luna toggle and forwards assignment policy", async () => {
    const h = harness({reply: [{content: "A complete answer. ".repeat(10)}]});
    const provider = await h.context.provider();
    assert.equal(provider.useLuna, false);
    assert.equal(provider.isChatGPTWeb, true);
    await provider.solve("Question", {});
    assert.equal(h.calls[0].options.chatgptPolicy.kind, "limited");
});
test("short or missing AI text never becomes an invented fallback answer", async () => {
    const h = harness({reply: [{content: "Too short"}]});
    const result = await h.context.solve({title: "Quiz", path: "/learn/c/quiz/a"}, "quiz");
    assert.equal(result.solved, false);
    assert.deepEqual(h.fills, []);
});
test("Pro selection errors pause solving without invoking screenshot or answer fallbacks", async () => {
    const h = harness({reply: new Error("PRO_MODE_UNAVAILABLE")});
    await assert.rejects(h.context.solve({title: "Quiz", path: "/learn/c/quiz/a"}, "quiz"), /PRO_MODE_UNAVAILABLE/);
    assert.deepEqual(h.fills, []);
    assert.equal(h.calls.length, 1);
});
test("a five-minute Pro solve does not consume the navigation and submission timeout", async () => {
    const source = fs.readFileSync("./course-runner.js", "utf8");
    const start = source.indexOf("    async function waitForQuizSubmission(");
    const end = source.indexOf("    async function waitForCompletionShift", start);
    let now = 1000, active = true, solves = 0;
    const location = {pathname: "/learn/c/quiz/a/attempt"};
    const context = {...helpers, window: {location}, location, Date: {now: () => now}, helpers, CourseRunnerHelpers: helpers,
        cachedPassingThreshold: 80, normalizePath: helpers.normalizePath, classifyQuizStateText: helpers.classifyQuizStateText,
        isPeerAssignmentSubmitted: helpers.isPeerAssignmentSubmitted,
        resolveQuizPageLoadState: () => "ready", resolveStartActionState: helpers.resolveStartActionState,
        resolveAttemptRelayState: helpers.resolveAttemptRelayState, shouldTreatExistingAttemptAsPassed: () => false,
        getQuizResultSettleMs: async () => 0, getRunState: async () => ({active}), getMainContentText: () => "Question 1",
        waitForCompletionShift: async () => null, sessionStorage: {getItem: () => null, setItem() {}},
        document: {readyState: "complete", querySelector: () => ({})},
        findNextItemButton: () => null, findHonorCodeCheckbox: () => null, findSubmitButton: () => null,
        findViewFeedbackButton: () => null, findRetryQuizButton: () => null, findStartAttemptModalConfirmButton: () => null,
        getQuizAnswerProgress: () => ({signature: "empty"}), buildQuizDomSnapshot: () => ({}),
        solveQuizDirectlyFromDom: async () => {solves++; now += 300000; active = false; return {solved: true};},
        updateRunState: async () => {}, delay: async (ms) => {now += ms;}, logRunner() {}, logRunnerWarn() {}, summarizeItem: () => ({}),
        START_TRANSITION_TIMEOUT_MS: 20000, ATTEMPT_RELAY_DELAY_MS: 3000, POLL_INTERVAL_MS: 1500,
    };
    vm.createContext(context); vm.runInContext(source.slice(start, end) + "\nthis.wait = waitForQuizSubmission;", context);
    const outcome = await context.wait("quiz", {path: "/learn/c/quiz/a", title: "Quiz"}, 120000);
    assert.equal(solves, 1);
    assert.equal(outcome.kind, "done");
});
