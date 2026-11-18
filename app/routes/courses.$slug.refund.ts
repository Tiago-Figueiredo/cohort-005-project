import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/courses.$slug.refund";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import { courses } from "~/db/schema";
import { eq } from "drizzle-orm";
import { parseFormData, parseParams } from "~/lib/validation";
import { checkRefundEligibility, requestRefund } from "~/lib/refunds.server";

const refundParamsSchema = z.object({
  slug: z.string().min(1),
});

const refundActionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Tell us a little more about why you want a refund.")
    .max(1000, "Please keep your reason under 1000 characters."),
});

export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in to request a refund.", { status: 401 });
  }

  const { slug } = parseParams(params, refundParamsSchema);
  const course = db.select().from(courses).where(eq(courses.slug, slug)).get();

  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  // Hard stops are checked before the form is read, so a learner who cannot
  // request a Refund is told why rather than asked to fix their reason.
  const check = checkRefundEligibility(currentUserId, course.id);
  if (!check.ok) {
    throw data(check.block.message, { status: check.block.status });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundActionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  const result = requestRefund(currentUserId, course.id, parsed.data.reason);
  if (!result.ok) {
    throw data(result.block.message, { status: result.block.status });
  }

  return redirect("/settings");
}
