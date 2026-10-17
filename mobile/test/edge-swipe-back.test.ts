import assert from "node:assert/strict";
import { test } from "node:test";
import { EdgeSwipeBackGesture } from "../src/domain/edgeSwipeBack";

test("only a deliberate rightward swipe from the left edge returns once", () => {
  const gesture = new EdgeSwipeBackGesture();
  assert.equal(gesture.begin(10, 200, 390), true);
  assert.equal(gesture.move(155, 208), true);
  assert.equal(gesture.release(), true);
  assert.equal(gesture.release(), false);
  assert.equal(gesture.distance, 0);
});

test("center swipes and disabled screens including editing never navigate", () => {
  const gesture = new EdgeSwipeBackGesture();
  for (const [x, enabled] of [[80, true], [10, false], [-1, true], [300, true]] as const) {
    assert.equal(gesture.begin(x, 200, 390, enabled), false);
    gesture.move(x + 200, 200);
    assert.equal(gesture.release(), false);
  }
});

test("short, leftward, vertical and diagonal gestures stay on the current screen", () => {
  const gesture = new EdgeSwipeBackGesture();
  for (const [x, y] of [[40, 200], [0, 200], [14, 350], [150, 360]]) {
    gesture.begin(12, 200, 390); gesture.move(x, y);
    assert.equal(gesture.release(), false);
  }
  gesture.begin(12, 200, 390); gesture.move(14, 250); gesture.move(200, 250);
  assert.equal(gesture.release(), false);
});

test("returning toward the edge and interrupted gestures cancel navigation", () => {
  const gesture = new EdgeSwipeBackGesture();
  gesture.begin(10, 200, 390); gesture.move(180, 200); gesture.move(30, 200);
  assert.equal(gesture.release(), false);
  gesture.begin(10, 200, 390); gesture.move(180, 200); gesture.cancel();
  assert.equal(gesture.release(), false);
});
