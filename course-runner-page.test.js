const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

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
    const context = { document, window: { getComputedStyle: (el) => ({ overflowY: el.overflowY }) },
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
    return { context, nodes, moves, sidebar, hidden, viewport };
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

test("section capture covers the full assignment with overlap and restores scroll", async () => {
    const h = scrollHarness();
    const capturedPositions = [];
    h.context.captureCurrentTabScreenshot = async () => {
        capturedPositions.push(h.viewport.scrollTop);
        return `image-${capturedPositions.length}`;
    };
    const images = await h.context.captureSections("quiz");
    assert.deepEqual(capturedPositions, [0, 280, 560, 600]);
    assert.equal(images.length, 4);
    assert.equal(h.viewport.scrollTop, 75);
    assert.ok(!h.moves.includes("sidebar"));
});

test("failed section capture restores scroll and rejects partial images", async () => {
    const h = scrollHarness();
    let count = 0;
    h.context.captureCurrentTabScreenshot = async () => ++count === 1 ? "image" : null;
    await assert.rejects(h.context.captureSections("quiz"), /Không chụp được/);
    assert.equal(h.viewport.scrollTop, 75);
});
