// ─── Refund Rules ───
// The policy itself, with no database or request in sight, so the learner's
// course page, the request route and the admin approval screen all apply the
// same rules. See docs/adr/0001-refund-revokes-access-keeps-progress.md.
//
// Two kinds of rule:
// - Hard stops decide whether a Refund can be requested at all.
// - Refund Warnings never block the learner. They are shown to the admin, who
//   must write a Resolution Note to Approve despite one.

export const REFUND_WINDOW_DAYS = 14;
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
export const REFUND_COMPLETION_LIMIT = 0.5;

export type RefundWarning = "watched_over_limit" | "completion_over_limit";

export type RefundDecision = "approve" | "decline";

/**
 * The window is counted in whole calendar days, not hours: someone who buys
 * at 23:00 still gets the whole of their fourteenth day.
 */
export function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

export function lastDayOfRefundWindow(purchasedAtIso: string): string {
  const deadline = new Date(purchasedAtIso);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}

export function isWithinRefundWindow(
  purchasedAtIso: string,
  now: Date = new Date()
): boolean {
  const today = calendarDay(now);
  return (
    today >= calendarDay(new Date(purchasedAtIso)) &&
    today <= lastDayOfRefundWindow(purchasedAtIso)
  );
}

/** Whole days since the purchase, by calendar day. */
export function daysSincePurchase(
  purchasedAtIso: string,
  now: Date = new Date()
): number {
  const start = new Date(calendarDay(new Date(purchasedAtIso)));
  const end = new Date(calendarDay(now));
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

export function getRefundWarnings(usage: {
  watchedSeconds: number;
  completedLessons: number;
  totalLessons: number;
}): RefundWarning[] {
  const warnings: RefundWarning[] = [];

  if (usage.watchedSeconds >= REFUND_WATCH_LIMIT_SECONDS) {
    warnings.push("watched_over_limit");
  }

  if (
    usage.totalLessons > 0 &&
    usage.completedLessons / usage.totalLessons >= REFUND_COMPLETION_LIMIT
  ) {
    warnings.push("completion_over_limit");
  }

  return warnings;
}

export function describeRefundWarning(warning: RefundWarning): string {
  switch (warning) {
    case "watched_over_limit":
      return `Watched ${REFUND_WATCH_LIMIT_SECONDS / 3600}h or more of video`;
    case "completion_over_limit":
      return `Completed ${REFUND_COMPLETION_LIMIT * 100}% or more of lessons`;
  }
}

/**
 * A Resolution Note is required to Decline, and to Approve despite a Refund
 * Warning. A clean Approve needs none.
 */
export function isResolutionNoteRequired(
  decision: RefundDecision,
  warnings: RefundWarning[]
): boolean {
  return decision === "decline" || warnings.length > 0;
}
