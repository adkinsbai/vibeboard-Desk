import assert from "node:assert/strict";
import { salarySnapshot } from "../market-apps/vb-salary-flip-counter/salary-logic.js";

const at = (hour, minute = 0, second = 0) => new Date(2026, 7, 27, hour, minute, second);
const before = salarySnapshot(at(8, 59));
assert.equal(before.amount, 0);
assert.equal(before.phase, "waiting");

const opening = salarySnapshot(at(9));
assert.equal(opening.amount, 0);
assert.equal(opening.progress, 0);
assert.equal(opening.phase, "earning");

const midday = salarySnapshot(at(13, 30));
assert.equal(midday.amount, 500);
assert.equal(midday.progress, 0.5);
assert.equal(midday.total, 1000);

const closing = salarySnapshot(at(18));
assert.equal(closing.amount, 1000);
assert.equal(closing.progress, 1);
assert.equal(closing.phase, "complete");

const after = salarySnapshot(at(21));
assert.equal(after.amount, 1000);
assert.equal(after.phase, "complete");
console.log("salary-flip-counter: daily salary boundary cases passed");
