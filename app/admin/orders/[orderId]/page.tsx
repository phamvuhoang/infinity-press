import Link from "next/link";

import { AdminPageHeader, AdminSection } from "@/components/admin/admin-page-header";
import { ManualPaymentDecision } from "@/components/admin/manual-payment-decision";
import { OrderRevokeForm } from "@/components/admin/order-revoke-form";
import { requireAdmin } from "@/lib/auth/admin";
import { formatPrice } from "@/lib/catalog/price";
import { getAdminOrder } from "@/lib/data/admin-orders";
import { formatDate } from "@/lib/i18n/format";

const textLink =
  "inline-flex min-h-11 items-center text-forest underline decoration-sand underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-forest";

export default async function AdminOrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  await requireAdmin({ next: `/admin/orders/${orderId}` });
  const order = await getAdminOrder(orderId);
  const when = (iso: string) => formatDate(iso, "en", { withTime: true });
  const isManual = order.payments.some((payment) => payment.provider === "manual");

  return (
    <div className="min-w-0 max-w-[56rem] [overflow-wrap:anywhere]">
      <AdminPageHeader eyebrow="Order" title={order.item?.title || order.id}>
        <p>
          {order.id} &middot; {order.referenceCode} &middot; {order.status} &middot; payment {order.paymentStatus}{" "}
          &middot; {formatPrice(order.totalMinor, order.currency, "en")} &middot; placed {when(order.createdAt)}
        </p>
      </AdminPageHeader>
      <div className="space-y-10">
        {isManual ? (
          <AdminSection title="Manual payment">
            {order.manualClaim ? (
              <p className="text-sm">
                Reported {when(order.manualClaim.claimedAt)}
                {order.manualClaim.note ? ` · “${order.manualClaim.note}”` : ""}
              </p>
            ) : (
              <p className="text-sage-text">No transfer reported yet.</p>
            )}

            {order.status === "pending" ? (
              <div className="mt-6">
                <ManualPaymentDecision currency={order.currency} expectedAmountMinor={order.totalMinor} orderId={order.id} />
              </div>
            ) : null}

            {order.manualConfirmation ? (
              <div className="mt-6 space-y-1 text-sm">
                <p>
                  Confirmed {when(order.manualConfirmation.confirmedAt)} &middot; received{" "}
                  {formatPrice(order.manualConfirmation.receivedAmountMinor, order.currency, "en")} &middot; reference{" "}
                  {order.manualConfirmation.bankReference}
                </p>
                {order.manualConfirmation.mismatchAccepted ? (
                  <p className="text-sage-text">Confirmed despite a mismatch with the order total.</p>
                ) : null}
                {order.manualConfirmation.note ? <p className="text-sage-text">Note: {order.manualConfirmation.note}</p> : null}
              </div>
            ) : null}
          </AdminSection>
        ) : null}
        <AdminSection title="Customer">
          <p>
            {order.email ?? "No email"} &middot;{" "}
            <Link className={textLink} href={`/admin/users/${order.profileId}`}>
              View user
            </Link>
          </p>
        </AdminSection>

        <AdminSection title="Item">
          {order.item ? (
            <p>
              <Link className={textLink} href={`/admin/books/${order.item.bookId}`}>
                {order.item.title || order.item.bookId}
              </Link>{" "}
              &middot; {formatPrice(order.item.unitPriceMinor, order.currency, "en")}
            </p>
          ) : (
            <p className="text-sage-text">No item.</p>
          )}
        </AdminSection>

        <AdminSection title="Payments">
          {order.payments.length === 0 ? (
            <p className="text-sage-text">No payments.</p>
          ) : (
            <ul className="border-t border-sand text-sm">
              {order.payments.map((payment) => (
                <li className="border-b border-sand py-3" key={payment.id}>
                  {payment.provider} &middot; {payment.status} &middot; {formatPrice(payment.amountMinor, payment.currency, "en")} &middot;{" "}
                  {payment.externalPaymentId ?? "no external ID"} &middot; created {when(payment.createdAt)}
                </li>
              ))}
            </ul>
          )}
        </AdminSection>

        <AdminSection title="Events">
          {order.events.length === 0 ? (
            <p className="text-sage-text">No payment events.</p>
          ) : (
            <ol className="border-t border-sand text-sm">
              {order.events.map((event) => (
                <li className="border-b border-sand py-3" key={event.id}>
                  {event.providerEventId} &middot; received {when(event.receivedAt)}
                  {event.processedAt ? ` · processed ${when(event.processedAt)}` : " · not processed"}
                </li>
              ))}
            </ol>
          )}
        </AdminSection>

        <AdminSection title="Access">
          {!order.entitlement ? (
            <p className="text-sage-text">This order granted no access.</p>
          ) : (
            <div className="space-y-4">
              <p className="text-sm">
                {order.entitlement.sourceType} &middot; {order.entitlement.status} &middot; granted {when(order.entitlement.grantedAt)}
              </p>
              {order.entitlement.status === "active" ? (
                <OrderRevokeForm orderId={order.id} />
              ) : (
                <p>Access from this order was revoked on {when(order.entitlement.revokedAt ?? order.entitlement.grantedAt)}.</p>
              )}
            </div>
          )}
        </AdminSection>
      </div>
    </div>
  );
}
