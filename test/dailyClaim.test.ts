import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BotState } from "../src/lib/state.js";
import {
  applyClaimOutcome,
  CLAIM_PAGE_URL,
  describeClaimStatus,
  markClaimedManually,
  maybeOpenClaimPage,
  shouldAttemptDailyClaim,
} from "../src/services/claimSchedule.js";

const fresh = (): BotState => ({ totalCyclesRun: 0, recentSwaps: [] });
const at = (iso: string) => new Date(iso);

describe("daily claim scheduling", () => {
  it("a blocked (403) login waits for the re-probe interval and needs a manual claim", () => {
    const now = at("2026-11-11T02:00:00Z");
    const st = applyClaimOutcome(fresh(), { kind: "blocked" }, now, 6);
    assert.equal(st.lastClaimState, "manual_required");
    assert.equal(st.nextClaimAttemptAt, "2026-11-11T08:00:00.000Z");
    assert.equal(shouldAttemptDailyClaim(st, at("2026-11-11T07:59:00Z")).shouldClaim, false);
    assert.equal(shouldAttemptDailyClaim(st, at("2026-11-11T08:00:00Z")).shouldClaim, true);
    assert.match(describeClaimStatus(st, at("2026-11-11T03:00:00Z")).text, /Manual claim/);
  });

  it("caps the re-probe at the next UTC reset", () => {
    const st = applyClaimOutcome(fresh(), { kind: "blocked" }, at("2026-11-11T21:00:00Z"), 6);
    assert.equal(st.nextClaimAttemptAt, "2026-11-12T00:00:00.000Z");
  });

  it("transient errors back off 5m → 15m → 60m", () => {
    const now = at("2026-11-11T02:00:00Z");
    const st = fresh();
    const expected = [5, 15, 60, 60];
    for (const mins of expected) {
      applyClaimOutcome(st, { kind: "transient", message: "boom" }, now, 6);
      assert.equal(Date.parse(st.nextClaimAttemptAt!) - now.getTime(), mins * 60_000);
    }
    assert.equal(st.lastClaimState, "retrying");
  });

  it("does not carry yesterday's 'claimed' into today", () => {
    const st = applyClaimOutcome(
      fresh(),
      { kind: "success", finalState: "claimed" },
      at("2026-11-10T05:00:00Z"),
      6
    );
    assert.equal(st.claimedForUtcDay, "2026-11-10");
    const today = at("2026-11-11T02:00:00Z");
    assert.equal(shouldAttemptDailyClaim(st, today).shouldClaim, true);
    assert.doesNotMatch(describeClaimStatus(st, today).text, /Claimed/);
    applyClaimOutcome(st, { kind: "blocked" }, today, 6);
    assert.equal(st.lastClaimState, "manual_required");
  });

  it("--claim-done marks today claimed until the next UTC reset", () => {
    const now = at("2026-11-11T02:46:00Z");
    const st = markClaimedManually(applyClaimOutcome(fresh(), { kind: "blocked" }, now, 6), now);
    assert.equal(shouldAttemptDailyClaim(st, at("2026-11-11T23:59:00Z")).shouldClaim, false);
    assert.match(describeClaimStatus(st, now).text, /\[OK\] Claimed \(2026-11-11\)/);
    assert.equal(shouldAttemptDailyClaim(st, at("2026-11-12T00:00:01Z")).shouldClaim, true);
  });

  it("opens the claim page at most once per UTC day, and only when enabled", () => {
    const st = fresh();
    const opened: string[] = [];
    const opener = (u: string) => opened.push(u);
    assert.equal(maybeOpenClaimPage(st, at("2026-11-11T02:00:00Z"), true, opener), true);
    assert.equal(maybeOpenClaimPage(st, at("2026-11-11T09:00:00Z"), true, opener), false);
    assert.equal(maybeOpenClaimPage(st, at("2026-11-12T00:10:00Z"), false, opener), false);
    assert.equal(maybeOpenClaimPage(st, at("2026-11-12T00:10:00Z"), true, opener), true);
    assert.deepEqual(opened, [CLAIM_PAGE_URL, CLAIM_PAGE_URL]);
  });
});
