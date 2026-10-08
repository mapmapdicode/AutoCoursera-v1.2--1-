const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function harness(initial = {}) {
    const data = {...initial};
    let listener, tabUpdated;
    const dispatched = [];
    const area = {get(keys, cb) {cb(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, data[key]])));},
        set(values, cb) {Object.assign(data, values); cb?.();}, remove(keys, cb) {(Array.isArray(keys) ? keys : [keys]).forEach((key) => delete data[key]); cb?.();}};
    const context = {console: {log() {}, error() {}}, URL, Date, setTimeout, clearTimeout, crypto: require("node:crypto").webcrypto,
        chrome: {storage: {local: area, session: area}, runtime: {id: "ext", onInstalled: {addListener() {}}, onMessage: {addListener(fn) {listener = fn;}}},
            tabs: {onUpdated: {addListener(fn) {tabUpdated = fn;}, removeListener() {}}, get(id, cb) {cb({id, url: "https://chatgpt.com/", status: "complete"});},
                update(id, changes, cb) {cb?.({id, url: "https://chatgpt.com/", status: "complete"});},
                create(options, cb) {cb({id: 8, url: options.url, status: "complete"});},
                sendMessage(id, message, cb) {dispatched.push(message); cb(message.type === "PING_CHATGPT" ? {isReady: true, loggedIn: true} : {ok: true});}}}};
    vm.createContext(context); vm.runInContext(fs.readFileSync("./background.js", "utf8"), context);
    return {data, dispatched, tabUpdated: () => tabUpdated(1, {status: "complete"}, {url: "https://www.coursera.org/learn/c/quiz/a/attempt"}), call(message, sender = {id: "ext", tab: {id: 1, url: "https://www.coursera.org/learn/c/quiz/a/attempt"}}) {
        return new Promise((resolve) => {const handled = listener(message, sender, resolve); if (handled !== true) resolve(undefined);});
    }};
}

test("Pro jobs acknowledge quickly, stay pending, and only expose a matching completed result", async () => {
    const h = harness({chatgptWebTab: {id: 8, assignmentKey: "a"}});
    const started = await h.call({type: "startChatGPTJob", prompt: "Quiz", options: {mode: "pro", assignmentKey: "a"}});
    assert.equal(started?.ok, true);
    assert.ok(started.requestId);
    await new Promise((resolve) => setImmediate(resolve));
    const pending = await h.call({type: "getChatGPTJob", requestId: started.requestId});
    assert.equal(pending.status, "running");
    const request = h.dispatched.find((m) => m.type === "START_CHATGPT_JOB");
    assert.equal(request.options.reasoningEffort, "max");
    await h.call({type: "chatGPTJobResult", requestId: started.requestId, ok: true, text: "final"},
        {id: "ext", tab: {id: 99, url: "https://chatgpt.com/"}});
    assert.equal((await h.call({type: "getChatGPTJob", requestId: started.requestId})).status, "running");
    await h.call({type: "chatGPTJobResult", requestId: started.requestId, ok: true, text: "final"},
        {id: "ext", tab: {id: 8, url: "https://chatgpt.com/"}});
    assert.equal((await h.call({type: "getChatGPTJob", requestId: started.requestId})).text, "final");
});
test("reload after a Pro error or user pause never automatically restarts solving", async () => {
    for (const state of [{quiz: false}, {quiz: true, "quizRunState:1": {active: false, status: "paused"}},
        {quiz: true, "fullRunState:1": {active: false, status: "paused"}}]) {
        const h = harness(state);
        await h.tabUpdated();
        assert.equal(h.dispatched.some((message) => message.type === "solveChatGPTQuiz"), false);
    }
});
test("a second quiz cannot send a prompt into a running Pro conversation", async () => {
    const h = harness({chatgptWebTab: {id: 8, assignmentKey: "a"}});
    const first = await h.call({type: "startChatGPTJob", prompt: "One", options: {mode: "pro", assignmentKey: "a"}});
    assert.equal(first?.ok, true);
    const second = await h.call({type: "startChatGPTJob", prompt: "Two", options: {mode: "fast", assignmentKey: "a"}});
    assert.equal(second.ok, false);
    assert.match(second.error, /CHATGPT_BUSY/);
});
test("other tabs cannot retrieve a quiz result and expired jobs never expose partial output", async () => {
    const h = harness({chatgptWebTab: {id: 8, assignmentKey: "a"}});
    const first = await h.call({type: "startChatGPTJob", prompt: "One", options: {mode: "pro", assignmentKey: "a"}});
    assert.equal(first?.ok, true);
    const denied = await h.call({type: "getChatGPTJob", requestId: first.requestId},
        {id: "ext", tab: {id: 2, url: "https://www.coursera.org/learn/c/quiz/b/attempt"}});
    assert.equal(denied.ok, false);
    await new Promise((resolve) => setImmediate(resolve));
    h.data[`chatgptJob:${first.requestId}`].expiresAt = 0;
    const expired = await h.call({type: "getChatGPTJob", requestId: first.requestId});
    assert.equal(expired.status, "failed");
    assert.match(expired.error, /TIMEOUT/);
    assert.equal(expired.text, undefined);
});
