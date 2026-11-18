import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  checkRefundEligibility,
  listRequestedRefunds,
  requestRefund,
  resolveRefund,
} from "./refunds.server";

const NOW = new Date(2026, 10, 18, 12, 0);

function daysBefore(days: number) {
  const when = new Date(NOW);
  when.setDate(when.getDate() - days);
  return when.toISOString();
}

let base: ReturnType<typeof seedBaseData>;
let admin: typeof schema.users.$inferSelect;
let lessonIds: number[];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  testDb = createTestDb();
  base = seedBaseData(testDb);

  admin = testDb
    .insert(schema.users)
    .values({ name: "Admin", email: "admin@example.com", role: schema.UserRole.Admin })
    .returning()
    .get();

  testDb
    .update(schema.courses)
    .set({ price: 10000 })
    .where(eq(schema.courses.id, base.course.id))
    .run();

  const mod = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module", position: 1 })
    .returning()
    .get();

  lessonIds = [1, 2, 3, 4].map(
    (position) =>
      testDb
        .insert(schema.lessons)
        .values({ moduleId: mod.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
});

/** A personal purchase, enrolled, bought `daysAgo` before NOW. */
function buy(amountPaid: number, daysAgo = 3) {
  const purchase = testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid,
      country: null,
      createdAt: daysBefore(daysAgo),
    })
    .returning()
    .get();

  testDb
    .insert(schema.enrollments)
    .values({ userId: base.user.id, courseId: base.course.id })
    .run();

  return purchase;
}

function complete(count: number) {
  for (const lessonId of lessonIds.slice(0, count)) {
    testDb
      .insert(schema.lessonProgress)
      .values({
        userId: base.user.id,
        lessonId,
        status: schema.LessonProgressStatus.Completed,
        completedAt: NOW.toISOString(),
      })
      .run();
  }
}

function enrollment() {
  return testDb
    .select()
    .from(schema.enrollments)
    .where(
      and(
        eq(schema.enrollments.userId, base.user.id),
        eq(schema.enrollments.courseId, base.course.id)
      )
    )
    .get()!;
}

function onlyRefund() {
  return testDb.select().from(schema.refunds).get()!;
}

function request() {
  const result = requestRefund(base.user.id, base.course.id, "Not what I hoped for.", NOW);
  expect(result.ok).toBe(true);
  return onlyRefund();
}

describe("requesting a Refund", () => {
  it("refunds exactly the amount paid, not the list price", () => {
    // A coupon or discount: paid less than the 10000 list price.
    buy(4500);
    const check = checkRefundEligibility(base.user.id, base.course.id, NOW);
    expect(check.ok && check.eligibility.amount).toBe(4500);
  });

  it("is blocked once the Refund Window has closed", () => {
    buy(10000, 20);
    const result = requestRefund(base.user.id, base.course.id, "Too late?", NOW);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.block.status).toBe(403);
  });

  it("is not blocked by a Refund Warning", () => {
    buy(10000);
    complete(3);
    const check = checkRefundEligibility(base.user.id, base.course.id, NOW);
    expect(check.ok).toBe(true);
    expect(check.ok && check.eligibility.warnings).toEqual(["completion_over_limit"]);
  });

  it("cannot be repeated after a Decline", () => {
    buy(10000);
    const refund = request();
    resolveRefund({ refundId: refund.id, adminUserId: admin.id, decision: "decline", note: "No.", now: NOW });

    const again = requestRefund(base.user.id, base.course.id, "Please reconsider.", NOW);
    expect(again.ok).toBe(false);
    expect(!again.ok && again.block.status).toBe(409);
  });

  it("leaves Access in place while Requested", () => {
    buy(10000);
    request();
    expect(enrollment().revokedAt).toBeNull();
  });
});

describe("Approving a Refund", () => {
  it("records the amount and resolver, Revokes Access, and keeps Progress", () => {
    buy(4500);
    complete(1);
    const refund = request();

    const result = resolveRefund({
      refundId: refund.id,
      adminUserId: admin.id,
      decision: "approve",
      note: null,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    const resolved = onlyRefund();
    expect(resolved.status).toBe(schema.RefundStatus.Approved);
    expect(resolved.amountRefunded).toBe(4500);
    expect(resolved.resolvedByUserId).toBe(admin.id);
    expect(resolved.resolvedAt).toBe(NOW.toISOString());
    expect(enrollment().revokedAt).toBe(NOW.toISOString());
    expect(testDb.select().from(schema.lessonProgress).all()).toHaveLength(1);
  });

  it("needs a Resolution Note when a Refund Warning applies", () => {
    buy(10000);
    complete(2);
    const refund = request();

    const withoutNote = resolveRefund({
      refundId: refund.id,
      adminUserId: admin.id,
      decision: "approve",
      note: "  ",
      now: NOW,
    });
    expect(withoutNote).toMatchObject({ ok: false, status: 400 });
    expect(onlyRefund().status).toBe(schema.RefundStatus.Requested);

    const withNote = resolveRefund({
      refundId: refund.id,
      adminUserId: admin.id,
      decision: "approve",
      note: "Course content was misdescribed.",
      now: NOW,
    });
    expect(withNote.ok).toBe(true);
    expect(onlyRefund().resolutionNote).toBe("Course content was misdescribed.");
  });

  it("cannot Resolve the same Refund twice", () => {
    buy(10000);
    const refund = request();
    resolveRefund({ refundId: refund.id, adminUserId: admin.id, decision: "approve", note: null, now: NOW });

    const second = resolveRefund({
      refundId: refund.id,
      adminUserId: admin.id,
      decision: "decline",
      note: "Changed my mind.",
      now: NOW,
    });
    expect(second).toMatchObject({ ok: false, status: 409 });
  });

  it("is blocked when a team seat was claimed after the request", () => {
    const purchase = testDb
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 20000,
        createdAt: daysBefore(2),
      })
      .returning()
      .get();
    const team = testDb.insert(schema.teams).values({}).returning().get();
    const coupon = testDb
      .insert(schema.coupons)
      .values({ teamId: team.id, courseId: base.course.id, code: "SEAT", purchaseId: purchase.id })
      .returning()
      .get();

    const refund = request();

    testDb
      .update(schema.coupons)
      .set({ redeemedByUserId: base.instructor.id, redeemedAt: NOW.toISOString() })
      .where(eq(schema.coupons.id, coupon.id))
      .run();

    const result = resolveRefund({
      refundId: refund.id,
      adminUserId: admin.id,
      decision: "approve",
      note: null,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
  });
});

describe("Declining a Refund", () => {
  it("needs a Resolution Note and keeps Access", () => {
    buy(10000);
    const refund = request();

    expect(
      resolveRefund({ refundId: refund.id, adminUserId: admin.id, decision: "decline", note: null, now: NOW })
    ).toMatchObject({ ok: false, status: 400 });

    const result = resolveRefund({
      refundId: refund.id,
      adminUserId: admin.id,
      decision: "decline",
      note: "Outside our policy.",
      now: NOW,
    });

    expect(result.ok).toBe(true);
    const resolved = onlyRefund();
    expect(resolved.status).toBe(schema.RefundStatus.Declined);
    expect(resolved.amountRefunded).toBeNull();
    expect(enrollment().revokedAt).toBeNull();
  });
});

describe("listRequestedRefunds", () => {
  it("lists only Requested Refunds, with the amount paid and warnings", () => {
    buy(4500);
    complete(4);
    request();

    const [row, ...rest] = listRequestedRefunds(NOW);
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      amountPaid: 4500,
      refundAmount: 4500,
      completedLessons: 4,
      totalLessons: 4,
      daysSincePurchase: 3,
      warnings: ["completion_over_limit"],
      seatClaimed: false,
    });
  });
});
