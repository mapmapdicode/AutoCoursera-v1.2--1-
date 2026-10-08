const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function harness({mode = "Pro", customSlider = false, immutableSlider = false, onPoll = () => {}, draft = ""} = {}) {
    let time = 0, menuOpen = false, sent = false, generating = false, clicks = 0;
    let messages = [], complete = false;
    const element = (label, attrs = {}) => ({textContent: label, innerText: label, offsetParent: {}, hidden: false,
        getAttribute: (name) => attrs[name] ?? null, closest: () => null, querySelector: () => null,
        querySelectorAll: () => [], dispatchEvent() {}, focus() {}, disabled: false});
    const input = element(draft);
    const control = element(mode);
    control.click = () => {menuOpen = !menuOpen;};
    const choice = element("Pro", {role: "menuitemradio", "aria-checked": mode === "Pro" ? "true" : "false"});
    choice.click = () => {control.textContent = control.innerText = "Pro";};
    choice.closest = () => menuOpen ? {} : null;
    const instant = element("Instant", {role: "menuitemradio"});
    instant.click = () => {control.textContent = control.innerText = "Instant"; menuOpen = false;};
    instant.closest = choice.closest;
    const slider = element("", {role: "slider", "aria-valuemin": "0", "aria-valuemax": "4", "aria-valuenow": "1"});
    slider.tagName = customSlider ? "DIV" : "INPUT";
    slider.type = "range"; slider.min = "0"; slider.max = "4"; slider.value = "1";
    let sliderNow = "1";
    const originalGet = slider.getAttribute;
    slider.getAttribute = (name) => name === "aria-valuenow" ? sliderNow : originalGet(name);
    slider.dispatchEvent = (event) => {if (!immutableSlider && event.key === "End") sliderNow = "4";};
    const send = element("", {"data-testid": "send-button", "aria-label": "Send prompt"});
    send.click = () => {clicks++; sent = true; input.textContent = ""; generating = true;};
    const form = {querySelectorAll: () => [control, send]};
    input.closest = () => form;
    const stop = element("Stop");
    const assistant = (text, completed = false) => {
        const markdown = element(text);
        return {...element(""), querySelectorAll: () => [markdown],
            querySelector: (selector) => selector.includes("copy") && completed ? element("Copy") : null,
            getAttribute: () => null};
    };
    const document = {
        body: {innerText: ""},
        querySelector(selector) {
            if (selector.includes("prompt-textarea")) return input;
            if (selector.includes("model-switcher")) return control;
            if (selector.includes("send-button")) return send;
            if (selector.includes("stop-button")) return generating ? stop : null;
            return null;
        },
        querySelectorAll(selector) {
            if (selector.includes('type="range"') || selector.includes('role="slider"')) return menuOpen ? [slider] : [];
            if (selector.includes('data-message-author-role="assistant"')) return messages;
            if (selector.includes('role="menuitem"')) return menuOpen ? [choice, instant] : [];
            if (selector.includes("button")) return [control, send];
            return [];
        },
        execCommand(command, _, text) {input.textContent = text; return true;},
    };
    const context = {document, window: {location: {href: "https://chatgpt.com/"}}, console: {log() {}, error() {}},
        Event: class {constructor(type, options) {this.type = type; Object.assign(this, options);}},
        InputEvent: class {}, KeyboardEvent: class {constructor(type, options) {this.type = type; Object.assign(this, options);}},
        Date: {now: () => time},
        setTimeout(fn, ms) {time += ms; onPoll({time, sent, setGenerating: (value) => {generating = value;},
            setMessages: (value) => {messages = value;}, assistant}); fn();},
        chrome: {runtime: {onMessage: {addListener() {}}}},
    };
    const file = "./chatgpt-bridge.js";
    if (fs.existsSync(file)) {
        const source = fs.readFileSync(file, "utf8").replace("    chrome.runtime.onMessage.addListener", "    globalThis.bridge = {selectResponseMode, handleAskChatGPT, cancel: (id) => {cancelledRequestId = id;}};\n    chrome.runtime.onMessage.addListener");
        vm.createContext(context); vm.runInContext(source, context);
    }
    return {bridge: context.bridge || {}, slider, control, input, clicks: () => clicks,
        setMessages: (value) => {messages = value;}, assistant};
}

test("Pro uses the highest native slider value and verifies the selected mode", async () => {
    const h = harness();
    assert.equal(typeof h.bridge.selectResponseMode, "function");
    await h.bridge.selectResponseMode({mode: "pro"});
    assert.equal(h.slider.value, "4");
    assert.equal(h.control.textContent, "Pro");
});
test("Pro refuses an effort control that does not actually reach maximum", async () => {
    const h = harness({customSlider: true, immutableSlider: true});
    assert.equal(typeof h.bridge.selectResponseMode, "function");
    await assert.rejects(h.bridge.selectResponseMode({mode: "pro"}), /PRO_EFFORT/);
    assert.equal(h.clicks(), 0);
});
test("unlimited assignments switch away from Pro to Instant", async () => {
    const h = harness();
    assert.equal(typeof h.bridge.selectResponseMode, "function");
    await h.bridge.selectResponseMode({mode: "fast"});
    assert.equal(h.control.textContent, "Instant");
});
test("an available unselected Pro choice must be selected before setting effort", async () => {
    const h = harness({mode: "Reasoning effort"});
    await h.bridge.selectResponseMode({mode: "pro"});
    assert.equal(h.control.textContent, "Pro");
});
test("a response without final turn controls is not complete even if streaming appears idle", async () => {
    let partial;
    const h = harness({onPoll({sent, setGenerating, setMessages, assistant}) {
        if (!sent) return;
        if (!partial) partial = assistant('{"answers":[{"correctOptionsIndex":[1]}]}', false);
        setMessages([partial]); setGenerating(false);
    }});
    await assert.rejects(h.bridge.handleAskChatGPT("Quiz", {mode: "pro", timeoutMs: 4000}), /TIMEOUT/);
});
test("stable valid JSON during reasoning is never treated as a final answer", async () => {
    const text = '{"answers":[{"correctOptionsIndex":[1]}]}';
    let finalTurn;
    const h = harness({onPoll({time, sent, setGenerating, setMessages, assistant}) {
        if (!sent) return;
        if (!finalTurn) finalTurn = assistant(text, true);
        setMessages([finalTurn]);
        if (time >= 15000) setGenerating(false);
    }});
    assert.equal(typeof h.bridge.handleAskChatGPT, "function");
    const reply = await h.bridge.handleAskChatGPT("Solve", {mode: "pro", timeoutMs: 20000});
    assert.equal(reply, text);
    assert.equal(h.clicks(), 1);
});
test("an earlier completed response is never reused for a new request", async () => {
    const h = harness({onPoll({sent, setGenerating}) {if (sent) setGenerating(false);}});
    h.setMessages([h.assistant('{"answers":[{"correctOptionsIndex":[0]}]}', true)]);
    assert.equal(typeof h.bridge.handleAskChatGPT, "function");
    await assert.rejects(h.bridge.handleAskChatGPT("New quiz", {mode: "pro", timeoutMs: 3000}), /TIMEOUT/);
});
test("an unfinished draft is preserved instead of overwritten by automation", async () => {
    const h = harness({draft: "My unsent message"});
    assert.equal(typeof h.bridge.handleAskChatGPT, "function");
    await assert.rejects(h.bridge.handleAskChatGPT("Quiz", {mode: "pro"}), /DRAFT/);
    assert.equal(h.input.textContent, "My unsent message");
    assert.equal(h.clicks(), 0);
});
test("cancellation after composing prevents Send even when the button is already enabled", async () => {
    const h = harness();
    h.input.dispatchEvent = () => h.bridge.cancel("job-cancelled");
    await assert.rejects(h.bridge.handleAskChatGPT("Quiz", {mode: "pro", requestId: "job-cancelled"}), /CANCELLED/);
    assert.equal(h.clicks(), 0);
});
