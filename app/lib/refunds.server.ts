import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  RefundStatus,
  coupons,
  courses,
  enrollments,
  lessonProgress,
  lessons,
  LessonProgressStatus,
  modules,
  purchases,
  refunds,
  users,
  videoWatchEvents,
} from "~/db/schema";
import { formatPrice } from "~/lib/utils";
import {
  daysSincePurchase,
  getRefundWarnings,
  isResolutionNoteRequired,
  isWithinRefundWindow,
  lastDayOfRefundWindow,
  type RefundDecision,
  type RefundWarning,
} from "~/lib/refunds";

// ─── Refund Service ───
// Everything that reads or writes Refunds. The rules themselves live in
// ~/lib/refunds; this module gathers the facts they need and applies the
// outcome.

type Purchase = typeof purchases.$inferSelect;

export function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`, sql`${purchases.id} desc`)
    .get();
}

/** Any Refund on the purchase, whatever its state. */
function findRefundForPurchase(purchaseId: number) {
  return db
    .select()
    .from(refunds)
    .where(eq(refunds.purchaseId, purchaseId))
    .get();
}

function getCourseLessonIds(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return row?.count ?? 0;
}

/** Furthest point reached in each lesson's video, summed. */
function getSecondsWatched(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  return db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);
}

function hasClaimedSeat(purchaseId: number) {
  return !!db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
    )
    .get();
}

/** Did this purchase mint team seats, rather than buy the course for its buyer? */
function isTeamPurchase(purchaseId: number) {
  return !!db
    .select({ id: coupons.id })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchaseId))
    .get();
}

/** How much of the course the learner has used, as of right now. */
function getUsage(purchase: Purchase) {
  const lessonIds = getCourseLessonIds(purchase.courseId);
  return {
    watchedSeconds: getSecondsWatched(purchase.userId, lessonIds),
    completedLessons: getCompletedLessonCount(purchase.userId, lessonIds),
    totalLessons: lessonIds.length,
  };
}

export type RefundEligibility = {
  /** Always exactly what the learner paid. */
  amount: number;
  lastDayInWindow: string;
  warnings: RefundWarning[];
};

export type RefundBlock = {
  status: 403 | 409;
  message: string;
};

/**
 * Whether the learner may request a Refund on their latest purchase of the
 * course. Only hard stops block; Refund Warnings ride along for the admin.
 */
export function checkRefundEligibility(
  userId: number,
  courseId: number,
  now: Date = new Date()
):
  | { ok: true; purchase: Purchase; eligibility: RefundEligibility }
  | { ok: false; block: RefundBlock } {
  const purchase = getLatestPurchase(userId, courseId);

  if (!purchase) {
    return {
      ok: false,
      block: { status: 403, message: "You have not bought this course." },
    };
  }

  const existing = findRefundForPurchase(purchase.id);
  if (existing) {
    const message =
      existing.status === RefundStatus.Requested
        ? "You already have a Refund requested on this purchase."
        : existing.status === RefundStatus.Declined
          ? "A Refund on this purchase was already declined."
          : "This purchase has already been refunded.";
    return { ok: false, block: { status: 409, message } };
  }

  // A seat that came out of a team licence, and has been claimed, belongs to
  // the team — the buyer cannot hand it back on their own.
  if (hasClaimedSeat(purchase.id)) {
    return {
      ok: false,
      block: { status: 403, message: "A claimed team seat cannot be refunded." },
    };
  }

  if (!isWithinRefundWindow(purchase.createdAt, now)) {
    return {
      ok: false,
      block: { status: 403, message: "The 14-day Refund Window has closed." },
    };
  }

  return {
    ok: true,
    purchase,
    eligibility: {
      amount: purchase.amountPaid,
      lastDayInWindow: lastDayOfRefundWindow(purchase.createdAt),
      warnings: getRefundWarnings(getUsage(purchase)),
    },
  };
}

/**
 * The confirmation the learner gets in their inbox. There is no mail
 * transport wired up yet, so built messages go to the server log.
 */
export type Email = { to: string; subject: string; body: string };

export function sendEmail(email: Email) {
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}

function refundRequestedEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
}): Email {
  return {
    to: input.learnerEmail,
    subject: `Refund requested — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have your Refund request for "${input.courseTitle}".`,
      `The Refund is for ${formatPrice(input.amount)}, the amount you paid.`,
      "",
      "Our team reviews every Refund by hand. You keep access to the course until then — we will email you again when it is done.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

function refundApprovedEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
}): Email {
  return {
    to: input.learnerEmail,
    subject: `Refund approved — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `Your Refund for "${input.courseTitle}" has been approved, and ${formatPrice(input.amount)} has been refunded.`,
      "",
      "Your access to the course has ended. Your progress is kept, so if you buy the course again you will pick up where you left off.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

function refundDeclinedEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  note: string;
}): Email {
  return {
    to: input.learnerEmail,
    subject: `Refund declined — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have reviewed your Refund request for "${input.courseTitle}" and are unable to approve it.`,
      "",
      `Reason: ${input.note}`,
      "",
      "You keep full access to the course.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export function requestRefund(
  userId: number,
  courseId: number,
  reason: string,
  now: Date = new Date()
): { ok: true } | { ok: false; block: RefundBlock } {
  const check = checkRefundEligibility(userId, courseId, now);
  if (!check.ok) return check;

  db.insert(refunds)
    .values({
      purchaseId: check.purchase.id,
      status: RefundStatus.Requested,
      reason,
      requestedAt: now.toISOString(),
    })
    .run();

  const learner = db.select().from(users).where(eq(users.id, userId)).get();
  const course = db.select().from(courses).where(eq(courses.id, courseId)).get();

  if (learner && course) {
    sendEmail(
      refundRequestedEmail({
        learnerName: learner.name,
        learnerEmail: learner.email,
        courseTitle: course.title,
        amount: check.eligibility.amount,
      })
    );
  }

  return { ok: true };
}

export type RefundForReview = {
  refundId: number;
  requestedAt: string;
  reason: string;
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  courseSlug: string;
  purchasedAt: string;
  daysSincePurchase: number;
  amountPaid: number;
  refundAmount: number;
  watchedSeconds: number;
  completedLessons: number;
  totalLessons: number;
  warnings: RefundWarning[];
  /** A seat was claimed after the request, so it can no longer be Approved. */
  seatClaimed: boolean;
};

/** Every Requested Refund, oldest first, with usage measured right now. */
export function listRequestedRefunds(now: Date = new Date()): RefundForReview[] {
  const rows = db
    .select({ refund: refunds, purchase: purchases, learner: users, course: courses })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.status, RefundStatus.Requested))
    .orderBy(asc(refunds.requestedAt), asc(refunds.id))
    .all();

  return rows.map(({ refund, purchase, learner, course }) => {
    const usage = getUsage(purchase);
    return {
      refundId: refund.id,
      requestedAt: refund.requestedAt,
      reason: refund.reason,
      learnerName: learner.name,
      learnerEmail: learner.email,
      courseTitle: course.title,
      courseSlug: course.slug,
      purchasedAt: purchase.createdAt,
      daysSincePurchase: daysSincePurchase(purchase.createdAt, now),
      amountPaid: purchase.amountPaid,
      refundAmount: purchase.amountPaid,
      ...usage,
      warnings: getRefundWarnings(usage),
      seatClaimed: hasClaimedSeat(purchase.id),
    };
  });
}

export type ResolveResult =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 409; message: string };

/**
 * Approves or Declines a Requested Refund. Everything the decision changes
 * happens in one transaction, so a Refund is never Approved without its
 * Access being Revoked, or the other way round.
 */
export function resolveRefund(input: {
  refundId: number;
  adminUserId: number;
  decision: RefundDecision;
  note: string | null;
  now?: Date;
}): ResolveResult {
  const now = input.now ?? new Date();
  const note = input.note?.trim() || null;

  const row = db
    .select({ refund: refunds, purchase: purchases, learner: users, course: courses })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.id, input.refundId))
    .get();

  if (!row) {
    return { ok: false, status: 404, message: "Refund not found." };
  }

  const { refund, purchase, learner, course } = row;

  if (refund.status !== RefundStatus.Requested) {
    return {
      ok: false,
      status: 409,
      message: "This Refund has already been Resolved.",
    };
  }

  const warnings = getRefundWarnings(getUsage(purchase));

  if (isResolutionNoteRequired(input.decision, warnings) && !note) {
    return {
      ok: false,
      status: 400,
      message:
        input.decision === "decline"
          ? "A Resolution Note is required to Decline."
          : "A Resolution Note is required to Approve despite a Refund Warning.",
    };
  }

  const resolvedAt = now.toISOString();

  if (input.decision === "decline") {
    db.update(refunds)
      .set({
        status: RefundStatus.Declined,
        resolvedAt,
        resolvedByUserId: input.adminUserId,
        resolutionNote: note,
      })
      .where(eq(refunds.id, refund.id))
      .run();

    sendEmail(
      refundDeclinedEmail({
        learnerName: learner.name,
        learnerEmail: learner.email,
        courseTitle: course.title,
        note: note!,
      })
    );

    return { ok: true };
  }

  // Claiming a seat is a hard stop. A seat claimed after the request was made
  // still blocks the Approve.
  if (hasClaimedSeat(purchase.id)) {
    return {
      ok: false,
      status: 409,
      message: "A team seat from this purchase has been claimed since the request.",
    };
  }

  db.transaction((tx) => {
    tx.update(refunds)
      .set({
        status: RefundStatus.Approved,
        amountRefunded: purchase.amountPaid,
        resolvedAt,
        resolvedByUserId: input.adminUserId,
        resolutionNote: note,
      })
      .where(eq(refunds.id, refund.id))
      .run();

    // A team purchase bought seats for others, not the buyer's own Access:
    // its unclaimed seats stop being redeemable instead (see redeem route).
    if (!isTeamPurchase(purchase.id)) {
      tx.update(enrollments)
        .set({ revokedAt: resolvedAt })
        .where(
          and(
            eq(enrollments.userId, purchase.userId),
            eq(enrollments.courseId, purchase.courseId)
          )
        )
        .run();
    }
  });

  sendEmail(
    refundApprovedEmail({
      learnerName: learner.name,
      learnerEmail: learner.email,
      courseTitle: course.title,
      amount: purchase.amountPaid,
    })
  );

  return { ok: true };
}

/** Has this purchase been given back? Its team seats can no longer be redeemed. */
export function isPurchaseRefunded(purchaseId: number) {
  return !!db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.status, RefundStatus.Approved)
      )
    )
    .get();
}
