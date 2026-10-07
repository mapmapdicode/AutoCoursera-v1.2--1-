const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function harness({ sendButton = null, response = "", onDelay = () => {} } = {}) {
    let time = 0;
    const input = { textContent: "Prompt", focus() {}, dispatchEvent() {}, offsetParent: {} };
    const document = {
        querySelector(selector) {
            if (selector.includes('rich-textarea')) return input;
            return null;
        },
        querySelectorAll(selector) {
            if (selector === "button") return sendButton ? [sendButton] : [];
            if (selector === "message-content" && response) return [{ innerText: response }];
            return [];
        },
    };
    const context = {
        document, window: { location: { href: "https://gemini.google.com/app" } },
        console: { log() {} }, KeyboardEvent: class {}, Event: class {}, InputEvent: class {},
        Date: { now: () => time },
        setTimeout(fn, ms) { time += ms; onDelay(time, input, sendButton); fn(); },
        chrome: { runtime: { onMessage: { addListener() {} } } },
    };
    const source = fs.readFileSync(require.resolve("./gemini-bridge.js"), "utf8")
        .replace("    chrome.runtime.onMessage.addListener", "    globalThis.bridge = { findSendButton, triggerSend, handleAskGemini };\n    chrome.runtime.onMessage.addListener");
    vm.createContext(context);
    vm.runInContext(source, context);
    return { bridge: context.bridge, input };
}

test("Gemini finds an icon-only upward arrow send button", () => {
    const button = { offsetParent: {}, className: "", getAttribute: () => "",
        querySelector: () => ({ textContent: "arrow_upward", getAttribute: () => "" }) };
    assert.equal(harness({ sendButton: button }).bridge.findSendButton(), button);
});

test("Gemini waits for send button enablement and verifies composer cleared", async () => {
    let clicks = 0;
    let input;
    const button = { offsetParent: {}, disabled: true, className: "send-button",
        getAttribute: () => "Send message", querySelector: () => null,
        click() { clicks++; input.textContent = ""; } };
    const h = harness({ sendButton: button, onDelay(time) { if (time >= 800) button.disabled = false; } });
    input = h.input;
    await h.bridge.triggerSend(input);
    assert.equal(clicks, 1);
});

test("Gemini reports missing send control instead of pretending Enter was sent", async () => {
    const h = harness();
    await assert.rejects(h.bridge.triggerSend(h.input), /SEND_BUTTON/);
});

test("Gemini rejects a click that leaves the prompt unsent", async () => {
    const button = { offsetParent: {}, disabled: false, getAttribute: () => "Send message",
        querySelector: () => null, click() {} };
    const h = harness({ sendButton: button });
    await assert.rejects(h.bridge.triggerSend(h.input), /SEND_NOT_CONFIRMED/);
});

test("Gemini never returns an old answer while waiting for a new response", async () => {
    let input;
    const button = { offsetParent: {}, disabled: false, getAttribute: () => "Send message",
        querySelector: () => null, click() { input.textContent = ""; } };
    const h = harness({ sendButton: button, response: "Previous answer from an earlier quiz that must not be reused." });
    input = h.input;
    await assert.rejects(h.bridge.handleAskGemini("New quiz prompt", { timeoutMs: 1800 }), /TIMEOUT_WAIT_RESPONSE/);
});
