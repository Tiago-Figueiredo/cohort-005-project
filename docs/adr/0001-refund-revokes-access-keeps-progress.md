---
status: accepted
---

# An Approved Refund revokes Access but keeps Progress

A Refund returns a learner's money, so it ends what they paid for: Access to the course. It does not erase Progress, which is the learner's own record of what they did rather than something bought. So an Approved Refund marks the enrollment as Revoked instead of deleting it, leaves Progress untouched, and buying the course again restores both. The Refund itself is the only record of the outcome: the Purchase is never changed or ended, because it still happened.

Money follows the same rule of not rewriting history. The refund is always exactly the amount paid. In instructor revenue, past gross stays as sold, and the refund appears as a deduction in the period it was Approved. It is split between the platform fee and the instructor's net in the same proportion as the original sale, so the platform gives back its fee and the instructor loses only their share.

## Considered Options

- **Delete Progress on Refund.** Rejected: Progress belongs to the learner, and a returning learner would lose their work for no gain.
- **Delete the enrollment.** Rejected: it loses enrollment history and makes buying again a fresh start rather than a restoration.
- **Add an "ended" status to the Purchase.** Rejected: it creates a second record of the outcome that can drift from the Refund.
- **Remove the Purchase from past gross revenue.** Rejected: instructors' past reports would change under them.
- **Charge the whole refund to the instructor.** Rejected: they would lose more than they earned from the sale.

## Consequences

- Access checks must honour Revoked enrollments. Today they look only at whether an enrollment exists.
- How long Progress is kept is governed by account deletion. Any fixed purge window after a Refund is a separate privacy decision.
- Payment and refund records are kept for their own legal retention period, independent of Progress.
