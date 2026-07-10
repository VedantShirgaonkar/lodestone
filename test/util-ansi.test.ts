import { test } from "node:test";
import assert from "node:assert";
import {
  bold,
  red,
  green,
  yellow,
  blue,
  dim,
  progressBar,
} from "../src/util/ansi.js";

test("ansi: color functions return text when NO_COLOR set", () => {
  const orig = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";

  assert.equal(bold("text"), "text");
  assert.equal(red("text"), "text");
  assert.equal(green("text"), "text");

  process.env.NO_COLOR = orig;
});

test("ansi: progressBar creates bar string", () => {
  const bar = progressBar(50, 100, 10);
  assert.match(bar, /\[/);
  assert.match(bar, /\]/);
  assert.match(bar, /50%/);
});

test("ansi: progressBar calculates correct percentage", () => {
  const bar = progressBar(75, 100, 20);
  assert.match(bar, /75%/);

  const bar2 = progressBar(25, 100, 20);
  assert.match(bar2, /25%/);
});

test("ansi: progressBar handles edge cases", () => {
  const bar0 = progressBar(0, 100, 10);
  assert.match(bar0, /0%/);

  const bar100 = progressBar(100, 100, 10);
  assert.match(bar100, /100%/);
});
