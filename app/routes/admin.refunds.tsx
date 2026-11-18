import { useEffect, useState } from "react";
import { data, isRouteErrorResponse, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/admin.refunds";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { db } from "~/db";
import { UserRole, users } from "~/db/schema";
import { listRequestedRefunds, resolveRefund } from "~/lib/refunds.server";
import {
  describeRefundWarning,
  isResolutionNoteRequired,
  type RefundDecision,
  type RefundWarning,
} from "~/lib/refunds";
import { formatDuration, formatPrice } from "~/lib/utils";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Skeleton } from "~/components/ui/skeleton";
import { AlertTriangle, ReceiptText } from "lucide-react";

// ─── Refund Approval ───
// Where a Cadence admin Resolves Requested Refunds. The policy lives in
// ~/lib/refunds and docs/adr/0001-refund-revokes-access-keeps-progress.md;
// this page only shows the facts and records the decision.

const resolveSchema = z.object({
  refundId: z.coerce.number().int().positive(),
  decision: z.enum(["approve", "decline"]),
  note: z
    .string()
    .trim()
    .max(1000, "Please keep the Resolution Note under 1000 characters.")
    .optional(),
});

async function requireAdmin(request: Request) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }

  const user = db.select().from(users).where(eq(users.id, currentUserId)).get();

  if (!user || user.role !== UserRole.Admin) {
    throw data("Only admins can Resolve Refunds.", { status: 403 });
  }

  return user;
}

export function meta() {
  return [
    { title: "Refunds — Cadence" },
    { name: "description", content: "Approve or Decline Requested Refunds" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  return { refunds: listRequestedRefunds() };
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);

  const parsed = parseFormData(await request.formData(), resolveSchema);
  if (!parsed.success) {
    return data(
      { error: Object.values(parsed.errors)[0] ?? "Invalid input." },
      { status: 400 }
    );
  }

  const result = resolveRefund({
    refundId: parsed.data.refundId,
    adminUserId: admin.id,
    decision: parsed.data.decision,
    note: parsed.data.note ?? null,
  });

  if (!result.ok) {
    return data({ error: result.message }, { status: result.status });
  }

  return {
    success: true,
    message:
      parsed.data.decision === "approve"
        ? "Refund Approved. The learner's Access has been Revoked."
        : "Refund Declined. The learner keeps Access.",
  };
}

function formatDay(iso: string) {
  return iso.slice(0, 10);
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function RefundRow({
  refund,
}: {
  refund: Route.ComponentProps["loaderData"]["refunds"][number];
}) {
  const fetcher = useFetcher<typeof action>();
  const [note, setNote] = useState("");
  const isSubmitting = fetcher.state !== "idle";
  const warnings = refund.warnings as RefundWarning[];

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if ("error" in fetcher.data) toast.error(fetcher.data.error);
    else toast.success(fetcher.data.message);
  }, [fetcher.state, fetcher.data]);

  const noteMissing = (decision: RefundDecision) =>
    isResolutionNoteRequired(decision, warnings) && note.trim() === "";

  function submit(decision: RefundDecision) {
    fetcher.submit(
      { refundId: refund.refundId, decision, note },
      { method: "post" }
    );
  }

  const completionPercent =
    refund.totalLessons === 0
      ? 0
      : Math.round((refund.completedLessons / refund.totalLessons) * 100);

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-semibold">{refund.courseTitle}</h2>
            <p className="text-sm text-muted-foreground">
              {refund.learnerName} · {refund.learnerEmail}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            Requested {formatDay(refund.requestedAt)}
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <Fact
            label="Purchased"
            value={`${formatDay(refund.purchasedAt)} (${refund.daysSincePurchase} ${
              refund.daysSincePurchase === 1 ? "day" : "days"
            } ago)`}
          />
          <Fact label="Amount paid" value={formatPrice(refund.amountPaid)} />
          <Fact label="Refund amount" value={formatPrice(refund.refundAmount)} />
          <Fact
            label="Watched"
            value={formatDuration(
              Math.round(refund.watchedSeconds / 60),
              true,
              false,
              false
            )}
          />
          <Fact
            label="Completed"
            value={`${completionPercent}% (${refund.completedLessons}/${refund.totalLessons} lessons)`}
          />
        </dl>

        <div>
          <p className="text-xs text-muted-foreground">Learner's reason</p>
          <p className="mt-1 whitespace-pre-wrap text-sm">{refund.reason}</p>
        </div>

        {(warnings.length > 0 || refund.seatClaimed) && (
          <ul className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            {warnings.map((warning) => (
              <li key={warning} className="flex items-center gap-2">
                <AlertTriangle className="size-4 shrink-0 text-amber-600" />
                Refund Warning: {describeRefundWarning(warning)}
              </li>
            ))}
            {refund.seatClaimed && (
              <li className="flex items-center gap-2">
                <AlertTriangle className="size-4 shrink-0 text-destructive" />A
                team seat has been claimed since the request, so it can only be
                Declined.
              </li>
            )}
          </ul>
        )}

        <div className="space-y-2">
          <label
            htmlFor={`note-${refund.refundId}`}
            className="text-xs text-muted-foreground"
          >
            Resolution Note{" "}
            {warnings.length > 0
              ? "(required to Approve or Decline)"
              : "(required to Decline)"}
          </label>
          <Textarea
            id={`note-${refund.refundId}`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why this decision? A Decline note is emailed to the learner."
            maxLength={1000}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => submit("approve")}
            disabled={isSubmitting || refund.seatClaimed || noteMissing("approve")}
          >
            Approve {formatPrice(refund.refundAmount)}
          </Button>
          <Button
            variant="outline"
            onClick={() => submit("decline")}
            disabled={isSubmitting || noteMissing("decline")}
          >
            Decline
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { refunds } = loaderData;

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refunds</h1>
        <p className="mt-1 text-muted-foreground">
          Requested Refunds, oldest first. Approving refunds the amount paid
          and ends the learner's Access; their Progress is kept.
        </p>
      </div>

      {refunds.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <ReceiptText className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No Refunds are waiting for a decision.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {refunds.map((refund) => (
            <RefundRow key={refund.refundId} refund={refund} />
          ))}
        </div>
      )}
    </div>
  );
}

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6 lg:p-8">
      <Skeleton className="h-9 w-40" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading Refunds.";

  if (isRouteErrorResponse(error)) {
    title = error.status === 403 ? "Access denied" : `Error ${error.status}`;
    message = typeof error.data === "string" ? error.data : message;
  }

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}
