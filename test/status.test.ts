import { expect, test } from "bun:test";
import { formatStatus, type StatusInput } from "../src/status";

const status: StatusInput = {
  setup: "ready",
  pending: 0,
  running: false,
  lastPushAt: 60_000,
  lastPullAt: 600_000,
  error: null,
  serverEdited: 0,
  conflicts: 0,
  now: 660_000,
};

test("a fresh download cannot make stale or failed uploads look healthy", () => {
  expect(formatStatus(status)).toBe("YouSpot: upload 10m ago, download 1m ago");
  expect(formatStatus({ ...status, uploadError: "brain_limit", failed: 3 })).toBe(
    "YouSpot: uploads need attention (3 failed), download 1m ago",
  );
});

test("download failure and pending work have distinct visible states", () => {
  expect(formatStatus({ ...status, downloadError: "offline" })).toContain(
    "downloads need attention",
  );
  expect(formatStatus({ ...status, pending: 12 })).toContain("12 pending");
  expect(formatStatus({ ...status, setup: "none" })).toBe("YouSpot: not connected");
});
