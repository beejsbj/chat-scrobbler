import { expect, test } from "bun:test";
import { toolbarProgressView, aggregateTabProgress } from "../packages/extension/src/toolbar-progress";

test("toolbarProgressView maps active progress to a numeric badge and spinner", () => {
  expect(toolbarProgressView({ remaining: 7, total: 10 })).toEqual({
    badgeText: "7",
    badgeColor: "#0969da",
    spinning: true,
  });
});

test("toolbarProgressView clears badge and spinner at zero", () => {
  expect(toolbarProgressView({ remaining: 0, total: 10 })).toEqual({
    badgeText: "",
    badgeColor: null,
    spinning: false,
  });
});

// ---- aggregateTabProgress ----

test("aggregateTabProgress returns zero when map is empty", () => {
  const result = aggregateTabProgress(new Map());
  expect(result).toEqual({ remaining: 0, total: 0 });
});

test("aggregateTabProgress sums a single tab", () => {
  const tabs = new Map([[1, { remaining: 3, total: 5 }]]);
  expect(aggregateTabProgress(tabs)).toEqual({ remaining: 3, total: 5 });
});

test("aggregateTabProgress sums two tabs independently", () => {
  const tabs = new Map([
    [1, { remaining: 3, total: 5 }],
    [2, { remaining: 2, total: 4 }],
  ]);
  expect(aggregateTabProgress(tabs)).toEqual({ remaining: 5, total: 9 });
});

test("aggregateTabProgress drops a tab when remaining reaches zero and sums correctly", () => {
  // A tab that finished (remaining=0) should not count toward the aggregate remaining
  // but the caller should remove it from the map; the function itself just sums.
  // Verify that a tab with remaining=0 contributes 0 to remaining.
  const tabs = new Map([
    [1, { remaining: 0, total: 5 }],
    [2, { remaining: 2, total: 3 }],
  ]);
  expect(aggregateTabProgress(tabs)).toEqual({ remaining: 2, total: 8 });
});
