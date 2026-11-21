import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { LoaderCircle, Plus, Users } from 'lucide-react';
import type { InvoiceSummary } from '@taxdesk/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { createInvoiceDraft, listInvoices } from '../../billing-api.js';
import { ErrorAlert, LoadingMessage, type ErrorNotice } from '../../components/feedback.js';
import { invoicePath } from '../../routes.js';
import { useSession } from '../../session/session-context.js';
import { toErrorNotice } from '../error-notice.js';
import {
  INVOICE_STATUS_BADGE,
  INVOICE_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
  money,
} from './billing-format.js';

/**
 * Invoices for one client or case, with a "Create invoice" action. A case
 * invoice starts with the service fee; a client invoice starts empty. A group
 * head also gets "Create combined invoice" (TD-511): one invoice to the head
 * with lines for the head and its members. Shown only to roles that can read
 * billing, and never reads or changes case status.
 */
export function InvoicesCard({
  scope,
  archived = false,
  groupHead = false,
}: {
  scope: { readonly kind: 'client' | 'case'; readonly id: string };
  archived?: boolean;
  /** The client is a group head with visible members. */
  groupHead?: boolean;
}) {
  const { can } = useSession();
  const navigate = useNavigate();
  const canRead = can('billing.read');
  const canCreate = can('billing.manage') && !archived;
  const [invoices, setInvoices] = useState<readonly InvoiceSummary[] | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [creating, setCreating] = useState<'individual' | 'combined' | null>(null);

  useEffect(() => {
    if (!canRead) return;
    const controller = new AbortController();
    void listInvoices(
      scope.kind === 'case' ? { caseId: scope.id, limit: 50 } : { clientId: scope.id, limit: 50 },
      controller.signal,
    )
      .then((list) => {
        setInvoices(list.invoices);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setInvoices([]);
          setNotice(toErrorNotice(error, 'Could not load invoices'));
        }
      });
    return () => {
      controller.abort();
    };
  }, [canRead, scope.kind, scope.id]);

  if (!canRead) {
    return null;
  }

  async function create(mode: 'individual' | 'combined'): Promise<void> {
    setCreating(mode);
    setNotice(null);
    try {
      const draft = await createInvoiceDraft(
        scope.kind === 'case'
          ? { caseId: scope.id }
          : mode === 'combined'
            ? { clientId: scope.id, billingMode: 'combined' }
            : { clientId: scope.id },
      );
      void navigate(invoicePath(draft.id));
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not create the invoice'));
      setCreating(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle>
          <h2 className="text-base font-semibold">Invoices</h2>
        </CardTitle>
        {canCreate && (
          <div className="flex flex-wrap justify-end gap-2">
            {groupHead && scope.kind === 'client' && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={creating !== null}
                onClick={() => void create('combined')}
              >
                {creating === 'combined' ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" />
                ) : (
                  <Users aria-hidden="true" />
                )}
                Create combined invoice
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              disabled={creating !== null}
              onClick={() => void create('individual')}
            >
              {creating === 'individual' ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" />
              ) : (
                <Plus aria-hidden="true" />
              )}
              Create invoice
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {notice !== null && <ErrorAlert notice={notice} />}
        {invoices === null ? (
          <LoadingMessage>Loading invoices…</LoadingMessage>
        ) : invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <ul className="divide-y">
            {invoices.map((invoice) => (
              <li
                key={invoice.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <Link
                  to={invoicePath(invoice.id)}
                  className="font-mono text-sm font-medium text-primary underline-offset-4 hover:underline"
                >
                  {invoice.invoiceNumber ?? 'Draft invoice'}
                </Link>
                {invoice.billingMode === 'combined' && <Badge variant="outline">Combined</Badge>}
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  {money(invoice.totalMinor)}
                  <Badge variant={INVOICE_STATUS_BADGE[invoice.status]}>
                    {INVOICE_STATUS_LABELS[invoice.status]}
                  </Badge>
                  {invoice.status === 'finalized' && (
                    <span>{PAYMENT_STATUS_LABELS[invoice.paymentStatus]}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
