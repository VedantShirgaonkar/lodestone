import { test } from "node:test";
import assert from "node:assert";
import { weightedBurn, applyModelRatio, asPctOfWindow, switchTax, } from "../src/core/usage.js";
test("usage: weightedBurn applies weights correctly", () => {
    const usage = {
        input_tokens: 1000,
        output_tokens: 100,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 10000,
    };
    const burn = weightedBurn(usage);
    // 1000*1 + 100*5 + 500*2 + 10000*0.1 = 1000 + 500 + 1000 + 1000 = 3500
    assert.equal(burn, 3500);
});
test("usage: weightedBurn uses default weights", () => {
    const usage = {
        input_tokens: 100,
        output_tokens: 10,
    };
    const burn = weightedBurn(usage);
    // 100*1 + 10*5 = 150
    assert.equal(burn, 150);
});
test("usage: weightedBurn handles missing fields", () => {
    const usage = {
        input_tokens: 100,
    };
    const burn = weightedBurn(usage);
    assert.equal(burn, 100);
});
test("usage: applyModelRatio applies sonnet ratio", () => {
    const burn = applyModelRatio(100, "claude-3-5-sonnet-20241022");
    assert.equal(burn, 100); // sonnet ratio is 1
});
test("usage: applyModelRatio applies opus ratio", () => {
    const burn = applyModelRatio(100, "claude-opus-20250514");
    assert.equal(burn, 500); // opus ratio is 5
});
test("usage: applyModelRatio applies haiku ratio", () => {
    const burn = applyModelRatio(100, "claude-3-haiku");
    assert.equal(burn, 25); // haiku ratio is 0.25
});
test("usage: asPctOfWindow calculates pro budget correctly", () => {
    const pct = asPctOfWindow(50000, "pro");
    assert.equal(pct, 50); // 50k of 100k = 50%
});
test("usage: asPctOfWindow calculates max5 budget correctly", () => {
    const pct = asPctOfWindow(250000, "max5");
    assert.equal(pct, 50); // 250k of 500k = 50%
});
test("usage: asPctOfWindow calculates team budget correctly", () => {
    const pct = asPctOfWindow(2500000, "team");
    assert.equal(pct, 50); // 2.5M of 5M = 50%
});
test("usage: switchTax calculates naive cost", () => {
    const tax = switchTax(100000);
    assert.equal(tax.naive, 200000); // 2 * context
});
test("usage: switchTax calculates handoff cost", () => {
    const tax = switchTax(100000);
    assert.ok(tax.handoff > 0);
    assert.ok(tax.handoff < tax.naive); // handoff should be less than naive
});
