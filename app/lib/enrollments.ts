import { isNull } from "drizzle-orm";
import { enrollments } from "~/db/schema";

/**
 * The condition every "is this learner enrolled?" query adds: an enrollment
 * whose Access has been Revoked by an Approved Refund no longer counts.
 *
 * A function rather than a shared constant so each query gets its own SQL
 * fragment.
 */
export function isActiveEnrollment() {
  return isNull(enrollments.revokedAt);
}
