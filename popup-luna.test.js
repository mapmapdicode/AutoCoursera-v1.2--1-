const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function harness() {
    const source = fs.readFileSync(require.resolve("./popup.js"), "utf8");
    const saved = [];
    const context = { window: {}, document: {addEventListener() {}},
        setRunStatus() {}, storageSet: async (settings) => saved.push(settings) };
    vm.createContext(context);
    vm.runInContext(source + "\nthis.initLuna = initializeLunaAutofill; this.formLuna = readLunaAutofillForm;", context);
    // Override the real Chrome storage wrapper after loading the popup.
    context.storageSet = async (settings) => saved.push(settings);
    const element = () => ({ value: "", checked: false, handlers: {}, addEventListener(event, fn) { this.handlers[event] = fn; } });
    const elements = {lunaAutofillToggle: element(), lunaEndpointInput: element(), lunaKeysInput: element(), runStatus: {textContent: ""}};
    return {context, elements, saved};
}

test("Luna popup defaults off and persists its own toggle and credentials immediately", async () => {
    const h = harness();
    h.context.initLuna(h.elements, {});
    assert.equal(h.elements.lunaAutofillToggle.checked, false);
    assert.equal(h.elements.lunaEndpointInput.value, "https://llm.vcoderlog.com/");
    assert.equal(h.elements.lunaKeysInput.value, "");
    h.elements.lunaAutofillToggle.checked = true;
    h.elements.lunaEndpointInput.value = "https://api.apiz.vn/";
    h.elements.lunaKeysInput.value = "sk-luna\nsk-luna";
    await h.elements.lunaAutofillToggle.handlers.change();
    assert.equal(h.saved[0].lunaAutofillEnabled, true);
    assert.deepEqual(Array.from(h.saved[0].lunaAutofillKeys), ["sk-luna"]);
    assert.equal(h.saved[0].lunaAutofillEndpoint, "https://api.apiz.vn/v1/chat/completions");
    assert.equal(h.saved[0].aiMode, undefined);
    h.elements.lunaAutofillToggle.checked = false;
    await h.elements.lunaAutofillToggle.handlers.change();
    assert.equal(h.saved[1].lunaAutofillEnabled, false);
});

test("Luna popup restores saved state independently of primary API settings", () => {
    const h = harness();
    h.context.initLuna(h.elements, {lunaAutofillEnabled: true,
        lunaAutofillEndpoint: "https://api.apiz.vn/v1/chat/completions", lunaAutofillKeys: ["sk-own"],
        openaiKeys: ["sk-other"], apiEndpoint: "https://api.openai.com/"});
    assert.equal(h.elements.lunaAutofillToggle.checked, true);
    assert.equal(h.elements.lunaKeysInput.value, "sk-own");
    assert.equal(h.context.formLuna(h.elements).lunaAutofillEnabled, true);
});
