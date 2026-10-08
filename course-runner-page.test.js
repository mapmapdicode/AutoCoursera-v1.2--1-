const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("quiz provider routes enabled autofill to Luna and preserves the primary mode when off", async () => {
    const source = fs.readFileSync(require.resolve("./course-runner.js"), "utf8");
    const start = source.indexOf("    async function createQuizAnswerProvider(");
    const end = source.indexOf("    async function solveQuizDirectlyFromDom(", start);
    for (const enabled of [false, true]) {
        const calls = [];
        class AI {
            async readSettings() { return {aiMode: "api"}; }
            async solveQuestions(prompt, options) { calls.push(["primary", prompt, options]); return []; }
            async solveQuestionsViaLuna(prompt, options) { calls.push(["luna", prompt, options]); return []; }
        }
        const context = {window: {GeminiAI: AI}, storageGet: async () => ({lunaAutofillEnabled: enabled})};
        vm.createContext(context);
        vm.runInContext(source.slice(start, end) + "\nthis.provider = createQuizAnswerProvider;", context);
        const provider = await context.provider();
        assert.equal(provider.useLuna, enabled);
        assert.equal(provider.isChatGPTWeb, false);
        await provider.solve("question", {screenshotUrl: "image"});
        assert.equal(calls[0][0], enabled ? "luna" : "primary");
        assert.equal(calls[0][2].screenshotUrl, "image");
    }
});

test("Luna fills radio, checkbox and text answers; cancelled responses never change the page", async () => {
    const source = fs.readFileSync(require.resolve("./course-runner.js"), "utf8");
    const start = source.indexOf("    async function createQuizAnswerProvider(");
    const end = source.indexOf("    function summarizeItem(", start);
    for (const cancellation of [null, "toggle", "route", "pause"]) {
        let enabled = true;
        let active = true;
        const selected = [];
        const helpers = {...require("./course-runner-helpers.js"), copyRenderedQuestionText: () => "Question and options"};
        const option = (text) => ({text, input: {checked: false}});
        const questions = [
            {type: "single_choice", question: "Radio", options: ["A", "B"], optionElements: [option("A"), option("B")]},
            {type: "multi_select", question: "Checkbox", options: ["A", "B", "C"], optionElements: [option("A"), option("B"), option("C")]},
            {type: "text", question: "Text", inputElement: {value: ""}},
        ];
        const location = {pathname: "/learn/c/quiz/a/attempt"};
        class AI {
            async readSettings() {return {aiMode: "api"};}
            async solveQuestionsViaLuna(prompt) {
                if (cancellation === "toggle") enabled = false;
                if (cancellation === "route") location.pathname = "/learn/c/quiz/b";
                if (cancellation === "pause") active = false;
                return JSON.parse(prompt).questions.map((q) => q.type === "text"
                    ? {content: "A complete answer. ".repeat(10)}
                    : {correctOptionsIndex: q.type === "multi_select" ? [0, 2] : [1]});
            }
            async solveQuestions() { throw new Error("Should use Luna"); }
        }
        const context = {window: {GeminiAI: AI}, location, helpers, CourseRunnerHelpers: helpers,
            storageGet: async () => ({lunaAutofillEnabled: enabled}),
            normalizePath: helpers.normalizePath, getItemSlug: helpers.getItemSlug,
            getRunState: async () => ({active}), ensureAllQuizContentScrolledAndLoaded: async () => {},
            extractQuizQuestionsFromDom: () => questions, deriveCourseSlug: () => "c",
            loadCourseQuizMemory: async () => ({questions: {}, quizAttempts: {}}),
            extractAssignmentScenarioContext: () => "", logRunner() {}, logRunnerWarn() {}, summarizeItem: () => ({}),
            selectOptionInput: (input, checked) => {input.checked = checked; selected.push(input);},
            fillTextInput: async (input, content) => {input.value = content; selected.push(input);},
            validateQuestionElementAnswered: (q) => q.inputElement ? Boolean(q.inputElement.value) : q.optionElements.some((opt) => opt.input.checked),
            delay: async () => {}, sessionStorage: {setItem() {}},
        };
        vm.createContext(context);
        vm.runInContext(source.slice(start, end) + "\nthis.solve = solveQuizDirectlyFromDom;", context);
        const result = await context.solve({title: "Quiz", path: "/learn/c/quiz/a"}, "quiz");
        if (cancellation) {
            assert.equal(result, false);
            assert.equal(selected.length, 0);
        } else {
            assert.equal(result.solved, true);
            assert.equal(questions[0].optionElements[1].input.checked, true);
            assert.deepEqual(questions[1].optionElements.map((opt) => opt.input.checked), [true, false, true]);
            assert.ok(questions[2].inputElement.value.length > 80);
        }
    }
});

test("blank pages and stalled start transitions skip the item without stopping the run", async () => {
    const source = fs.readFileSync(require.resolve("./course-runner.js"), "utf8");
    const start = source.indexOf("    async function waitForQuizSubmission(");
    const end = source.indexOf("    async function waitForCompletionShift", start);
    for (const transitioning of [false, true]) {
        let now = 1000;
        let aborted = false;
        const context = {
            Date: { now: () => now },
            getQuizResultSettleMs: async () => 0,
            getRunState: async () => ({ active: true }),
            sessionStorage: { getItem: (key) => key.includes("assignmentTransition") && transitioning ? JSON.stringify({path: "/quiz/a", clickedAt: 0}) : null, removeItem() {} },
            matchesItemPath: () => true,
            getMainContentText: () => "",
            document: { readyState: "complete" },
            helpers: require("./course-runner-helpers.js"),
            resolveQuizPageLoadState: require("./course-runner-helpers.js").resolveQuizPageLoadState,
            delay: async () => { now += 10000; }, POLL_INTERVAL_MS: 1000,
            logRunner() {}, logRunnerWarn() {}, summarizeItem: () => ({}),
            buildQuizDomSnapshot: () => ({}), location: { href: "https://coursera.org/quiz/a/attempt" },
            abortRun: async () => { aborted = true; },
        };
        vm.createContext(context);
        vm.runInContext(source.slice(start, end) + "\nthis.wait = waitForQuizSubmission;", context);
        const outcome = await context.wait("quiz", {path: "/quiz/a"}, 90000);
        assert.equal(outcome.kind, "failed");
        assert.equal(aborted, false);
    }
});

test("locked attempts are handled before opening feedback", () => {
    const source = fs.readFileSync(require.resolve("./course-runner.js"), "utf8");
    assert.ok(source.indexOf('if (isCoverPage && isLocked)') < source.indexOf('if (isCoverPage && (hasFailedBanner'));
});

test("next quiz prefers the current module then searches other modules", () => {
    const source = fs.readFileSync(require.resolve("./course-runner.js"), "utf8");
    const start = source.indexOf("    function pickNextItemForMode(");
    const end = source.indexOf("    function currentItemPatch", start);
    const helpers = require("./course-runner-helpers.js");
    const context = { RUN_MODE_QUIZ: "quiz", location: { pathname: "/learn/c/quiz/current" },
        matchesItemPath: (a, b) => a === b,
        pickFirstIncompleteQuiz: helpers.pickFirstIncompleteQuiz };
    vm.createContext(context);
    vm.runInContext(source.slice(start, end) + "\nthis.pick = pickNextItemForMode;", context);
    const items = [
        {path: "/learn/c/quiz/earlier", type: "quiz", moduleId: "one"},
        {path: context.location.pathname, type: "quiz", moduleId: "two"},
        {path: "/learn/c/quiz/same", type: "quiz", moduleId: "two"},
    ];
    const skipped = new Set([items[1].path]);
    assert.equal(context.pick("quiz", items, new Map(), skipped), items[2]);
    skipped.add(items[2].path);
    assert.equal(context.pick("quiz", items, new Map(), skipped), items[0]);
    assert.equal(context.pick("quiz", items, new Map([[items[0].path, true]]), skipped), null);
});

// Exercise the production scroll function with a page containing a sidebar
// and a nested assignment viewport, without bootstrapping the extension.
function scrollHarness() {
    const source = fs.readFileSync(require.resolve("./course-runner.js"), "utf8");
    const start = source.indexOf("    async function ensureAllQuizContentScrolledAndLoaded(");
    const end = source.indexOf("    function extractAssignmentScenarioContext", start);
    const nodes = [];
    function node(name, parentElement = null, overflowY = "auto") {
        const el = { name, parentElement, scrollTop: 75, scrollHeight: 1000,
            clientHeight: 400, style: {}, isConnected: true,
            getBoundingClientRect: () => ({ width: 500, height: 400 }),
            contains: (el) => el === main || el === viewport,
            scrollIntoView() { moves.push(`into:${this.name}`); },
            dispatchEvent() {}, querySelectorAll: () => [], overflowY };
        nodes.push(el);
        return el;
    }
    const root = node("root", null, "visible");
    const viewport = node("viewport", root);
    const main = node("main", viewport, "visible");
    const sidebar = node("sidebar", root);
    const hidden = node("hidden", main, "hidden");
    const document = { readyState: "complete", scrollingElement: root,
        body: root, documentElement: root,
        querySelector: () => main,
        querySelectorAll: () => nodes };
    main.querySelectorAll = () => [hidden];
    const moves = [];
    for (const el of nodes) {
        let top = el.scrollTop;
        Object.defineProperty(el, "scrollTop", { get: () => top,
            set(value) { moves.push(el.name); top = value; } });
    }
    const context = { document, window: { scrollY: 45, scrollTo(x, y) { moves.push(`window:${y}`); }, getComputedStyle: (el) => ({ overflowY: el.overflowY }) },
        location: { pathname: "/learn/course/quiz/item/attempt" },
        HTMLElement: Object, Event: class {}, RUN_MODE_QUIZ: "quiz",
        getRunState: async () => ({ active: true }),
        delay: async () => {}, logRunner() {} };
    vm.createContext(context);
    vm.runInContext(source.slice(start, end) + "\nthis.scroll = ensureAllQuizContentScrolledAndLoaded;", context);
    context.getComputedStyle = context.window.getComputedStyle;
    context.window.innerHeight = 400;
    const captureStart = source.indexOf("    async function captureQuestionSections(");
    const captureEnd = source.indexOf("    async function attemptVisionNavigationFallback", captureStart);
    vm.runInContext(source.slice(captureStart, captureEnd) + "\nthis.captureSections = captureQuestionSections;", context);
    return { context, nodes, moves, sidebar, hidden, viewport, main };
}

test("assignment scan restores scroll and leaves sidebar and CSS untouched", async () => {
    const h = scrollHarness();
    await h.context.scroll();
    assert.ok(h.moves.includes("viewport"));
    assert.ok(!h.moves.includes("sidebar"));
    for (const el of h.nodes) {
        assert.equal(el.scrollTop, 75, el.name);
        assert.deepEqual(el.style, {});
    }
});

test("assignment scan does nothing while the document is loading", async () => {
    const h = scrollHarness();
    h.context.document.readyState = "loading";
    await h.context.scroll();
    assert.deepEqual(h.moves, []);
});

test("assignment scan stops and restores the viewport if the route changes", async () => {
    const h = scrollHarness();
    h.context.delay = async () => { h.context.location.pathname = "/learn/course/quiz/other"; };
    await h.context.scroll();
    assert.equal(h.viewport.scrollTop, 75);
    assert.ok(h.moves.length <= 3);
});

test("assignment scan stops when the user stops automation", async () => {
    const h = scrollHarness();
    h.context.getRunState = async () => ({ active: false });
    await h.context.scroll();
    assert.equal(h.viewport.scrollTop, 75);
    assert.ok(!h.moves.includes("sidebar"));
});

test("image fallback captures only the questions in the current small batch", async () => {
    const h = scrollHarness();
    const captured = [];
    h.context.captureCurrentTabScreenshot = async () => {
        captured.push(h.nodes.find((el) => el.name === "q1" || el.name === "q2")?.name);
        return `image-${captured.length}`;
    };
    const q1 = { name: "q1", parentElement: h.main, scrollTop: 0, isConnected: true, scrollIntoView() { h.nodes.push(this); } };
    const q2 = { name: "q2", parentElement: h.main, scrollTop: 0, isConnected: true, scrollIntoView() { h.nodes.push(this); } };
    h.main.contains = (el) => el === q1 || el === q2;
    const images = await h.context.captureSections("quiz", [{ container: q1 }, { container: q2 }]);
    assert.equal(images.length, 2);
    assert.equal(h.viewport.scrollTop, 75);
    assert.ok(h.context.window.scrollTo);
    assert.ok(!h.moves.includes("sidebar"));
});

test("failed section capture restores scroll and rejects partial images", async () => {
    const h = scrollHarness();
    h.context.captureCurrentTabScreenshot = async () => null;
    const q = { parentElement: h.main, scrollTop: 0, isConnected: true, scrollIntoView() {} };
    h.main.contains = (el) => el === q;
    await assert.rejects(h.context.captureSections("quiz", [{ container: q }]), /Không chụp được/);
    assert.equal(h.viewport.scrollTop, 75);
});

test("quiz fallback fills only a complete confirmed checkbox answer and never guesses", async () => {
    const source = fs.readFileSync(require.resolve("./course-runner.js"), "utf8");
    const start = source.indexOf("    async function attemptAutoFillMissingQuestions(");
    const end = source.indexOf("    function getQuizMemoryKey", start);
    const selected = [];
    const context = {
        helpers: require("./course-runner-helpers.js"),
        logRunner() {},
        summarizeItem: () => ({}),
        selectOptionInput: (input, checked) => selected.push([input, checked]),
        delay: async () => {},
    };
    vm.createContext(context);
    vm.runInContext(source.slice(start, end) + "\nthis.autofill = attemptAutoFillMissingQuestions;", context);

    const makeQuestion = (memory) => ({
        type: "multi_select",
        memory,
        optionElements: [
            { text: "Cost", input: "cost" },
            { text: "Threats", input: "threats" },
            { text: "Stakeholders", input: "stakeholders" },
        ],
    });
    const incomplete = makeQuestion({ confirmedCorrectOptions: ["Cost", "Stakeholders"], confirmedCompleteSet: false });
    await context.autofill([incomplete], { title: "Capability" }, "quiz");
    assert.deepEqual(selected, []);
    assert.equal(incomplete.actualChosenOptions, undefined);

    const complete = makeQuestion({ confirmedCorrectOptions: ["Cost", "Stakeholders"], confirmedCompleteSet: true });
    await context.autofill([complete], { title: "Capability" }, "quiz");
    assert.deepEqual(selected, [["cost", true], ["stakeholders", true]]);
    assert.deepEqual(complete.actualChosenOptions, ["Cost", "Stakeholders"]);
});
