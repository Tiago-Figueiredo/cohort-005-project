import { describe, it, expect } from "vitest";
import {
  REFUND_WATCH_LIMIT_SECONDS,
  daysSincePurchase,
  getRefundWarnings,
  isResolutionNoteRequired,
  isWithinRefundWindow,
} from "./refunds";

describe("Refund rules", () => {
  describe("isWithinRefundWindow", () => {
    const purchasedAt = new Date(2026, 10, 1, 23, 0).toISOString();

    it("is open on the day of purchase", () => {
      expect(isWithinRefundWindow(purchasedAt, new Date(2026, 10, 1, 23, 30))).toBe(true);
    });

    it("is open for the whole fourteenth day", () => {
      expect(isWithinRefundWindow(purchasedAt, new Date(2026, 10, 15, 23, 59))).toBe(true);
    });

    it("is closed on the fifteenth day", () => {
      expect(isWithinRefundWindow(purchasedAt, new Date(2026, 10, 16, 0, 1))).toBe(false);
    });
  });

  describe("daysSincePurchase", () => {
    it("counts calendar days", () => {
      const purchasedAt = new Date(2026, 10, 1, 23, 0).toISOString();
      expect(daysSincePurchase(purchasedAt, new Date(2026, 10, 3, 1, 0))).toBe(2);
    });
  });

  describe("getRefundWarnings", () => {
    it("has none for light use", () => {
      expect(
        getRefundWarnings({ watchedSeconds: 60, completedLessons: 1, totalLessons: 10 })
      ).toEqual([]);
    });

    it("warns at the watch limit", () => {
      expect(
        getRefundWarnings({
          watchedSeconds: REFUND_WATCH_LIMIT_SECONDS,
          completedLessons: 0,
          totalLessons: 10,
        })
      ).toEqual(["watched_over_limit"]);
    });

    it("warns at half the lessons completed", () => {
      expect(
        getRefundWarnings({ watchedSeconds: 0, completedLessons: 5, totalLessons: 10 })
      ).toEqual(["completion_over_limit"]);
    });

    it("does not divide by zero for a course with no lessons", () => {
      expect(
        getRefundWarnings({ watchedSeconds: 0, completedLessons: 0, totalLessons: 0 })
      ).toEqual([]);
    });
  });

  describe("isResolutionNoteRequired", () => {
    it("is required to Decline", () => {
      expect(isResolutionNoteRequired("decline", [])).toBe(true);
    });

    it("is not required for a clean Approve", () => {
      expect(isResolutionNoteRequired("approve", [])).toBe(false);
    });

    it("is required to Approve despite a Refund Warning", () => {
      expect(isResolutionNoteRequired("approve", ["completion_over_limit"])).toBe(true);
    });
  });
});
