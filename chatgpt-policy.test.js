const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
let policy;
try { policy = require("./chatgpt-policy"); } catch { policy = {}; }

test("only an explicit unlimited-attempt notice enables fast responses", () => {
    assert.equal(typeof policy.classifyAttempts, "function");
    for (const [text, kind, mode] of [
        ["Practice Assignment\nUnlimited attempts", "unlimited", "fast"],
        ["3 attempts\nevery 24 hours", "limited", "pro"],
        ["3 attempts remaining", "limited", "pro"],
        ["Số lần thử không giới hạn", "unlimited", "fast"],
        ["3 lượt làm mỗi 24 giờ", "limited", "pro"],
        ["Question 1. No attempt information", "unknown", "pro"],
        ["Unlimited attempts\n3 attempts every 24 hours", "limited", "pro"],
    ]) {
        const result = policy.classifyAttempts(text);
        assert.equal(result.kind, kind, text);
        assert.equal(result.mode, mode, text);
        if (mode === "pro") assert.equal(result.reasoningEffort, "max");
    }
});

test("cover-page policy survives navigation to its attempt but never leaks to another quiz", () => {
    const entries = new Map();
    const storage = {getItem: (key) => entries.get(key), setItem: (key, value) => entries.set(key, value)};
    assert.equal(typeof policy.rememberPolicy, "function");
    policy.rememberPolicy("/learn/visio/assignment-submission/one/title", "Unlimited attempts", storage);
    const first = policy.getPolicy("/learn/visio/assignment-submission/one/title/attempt", "Question 1", storage);
    assert.equal(first.mode, "fast");
    assert.equal(policy.getPolicy("/learn/visio/assignment-submission/two/title/attempt", "Question 1", storage).mode, "pro");
    policy.rememberPolicy("/learn/visio/assignment-submission/one/title", "3 attempts every 24 hours", storage);
    assert.equal(policy.getPolicy("/learn/visio/assignment-submission/one/title/attempt", "", storage).mode, "pro");
    assert.equal(policy.getPolicy("/learn/other/assignment-submission/one/title/attempt", "", storage).mode, "pro");
});

test("missing or damaged session storage uses Pro instead of guessing unlimited", () => {
    assert.equal(typeof policy.getPolicy, "function");
    const broken = {getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }};
    assert.equal(policy.getPolicy("/learn/c/quiz/a/attempt", "", broken).mode, "pro");
    assert.equal(policy.getPolicy("/learn/c/quiz/a/attempt", "", {getItem: () => '{"kind":"unlimited"}'}).mode, "pro");
});
test("SPA navigation cannot cache the previous quiz's unlimited notice for a limited quiz", () => {
    const entries = new Map();
    let text = "Unlimited attempts", heading = "Practice quiz A";
    const context = {location: {hostname: "www.coursera.org", pathname: "/learn/c/quiz/a"},
        sessionStorage: {getItem: (key) => entries.get(key), setItem: (key, value) => entries.set(key, value)},
        document: {body: {}, addEventListener() {}, querySelector: () => ({
            querySelector: () => ({textContent: heading}), cloneNode: () => ({textContent: text, querySelectorAll: () => []}),
        })}, MutationObserver: class {observe() {}}, setTimeout() {}, Date};
    vm.createContext(context); vm.runInContext(fs.readFileSync("./chatgpt-policy.js", "utf8"), context);
    assert.equal(context.ChatGPTPolicy.currentPolicy().mode, "fast");
    context.location.pathname = "/learn/c/quiz/b/attempt";
    assert.equal(context.ChatGPTPolicy.currentPolicy().mode, "pro");
    text = "Question 1"; heading = "Graded quiz B";
    assert.equal(context.ChatGPTPolicy.currentPolicy().mode, "pro");
    context.location.pathname = "/learn/c/quiz/a/attempt";
    heading = "Practice quiz A";
    assert.equal(context.ChatGPTPolicy.currentPolicy().mode, "fast");
});
