import assert from "node:assert/strict";
import { test } from "node:test";
import { PullToRefreshGesture, PULL_THRESHOLD, MAX_PULL_DISTANCE } from "../src/domain/pullToRefresh";

test("a downward pull at the top refreshes once after release", () => {
  const gesture = new PullToRefreshGesture();
  gesture.begin(100, 100, 0);
  assert.equal(gesture.move(102, 250, 0), true);
  assert.ok(gesture.distance >= PULL_THRESHOLD);
  assert.equal(gesture.release(), true);
  assert.equal(gesture.release(), false);
  assert.equal(gesture.distance, 0);
});
test("short pulls and returning the finger cancel without refreshing", () => {
  const gesture = new PullToRefreshGesture();
  gesture.begin(100, 100, 0);
  assert.equal(gesture.move(101, 103, 0), true);
  assert.equal(gesture.active, false);
  assert.equal(gesture.distance, 0);
  assert.equal(gesture.release(), false);
  gesture.begin(100, 100, 0); gesture.move(100, 130, 0);
  assert.equal(gesture.release(), false);
  gesture.begin(100, 100, 0); gesture.move(100, 280, 0); gesture.move(100, 105, 0);
  assert.equal(gesture.release(), false);
});
test("ordinary scrolling, sideways swipes and a busy list do not refresh", () => {
  const gesture = new PullToRefreshGesture();
  for (const blocked of [false, true]) {
    gesture.begin(100, 100, blocked ? 0 : 300, blocked); gesture.move(100, 300, 0);
    assert.equal(gesture.release(), false);
  }
  gesture.begin(100, 100, 0); gesture.move(140, 105, 0); gesture.move(140, 300, 0);
  assert.equal(gesture.release(), false);
  gesture.begin(100, 100, 0); gesture.move(100, 60, 0); gesture.move(100, 300, 0);
  assert.equal(gesture.release(), false);
});
test("cancellation and scrolling away from the top never trigger refresh", () => {
  const gesture = new PullToRefreshGesture();
  gesture.begin(0, 0, -5); gesture.move(0, 1000, 0);
  assert.equal(gesture.distance, MAX_PULL_DISTANCE);
  gesture.cancel(); assert.equal(gesture.release(), false);
  gesture.begin(0, 0, 0); gesture.move(0, 150, 10);
  assert.equal(gesture.release(), false);
});
