import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Plus } from 'lucide-react';
import type { CaseListItem } from '@taxdesk/shared';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { listCases } from '../../case-api.js';
import { ErrorAlert, LoadingMessage, type ErrorNotice } from '../../components/feedback.js';
import { CASE_READ_PERMISSIONS, casePath, newCasePath } from '../../routes.js';
import { useSession } from '../../session/session-context.js';
import { toErrorNotice } from '../error-notice.js';
import { STATUS_KIND_BADGE, formatDate } from './case-format.js';

/** A client's open and closed (not archived) cases, with a shortcut to open one. */
export function ClientCasesCard({ clientId, archived }: { clientId: string; archived: boolean }) {
  const { can } = useSession();
  const canRead = CASE_READ_PERMISSIONS.some((permission) => can(permission));
  const canOpen = !archived && (can('cases.manage') || can('cases.work_assigned'));
  const [cases, setCases] = useState<readonly CaseListItem[] | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);

  useEffect(() => {
    if (!canRead) return;
    const controller = new AbortController();
    void Promise.all([
      listCases({ view: 'team', client: clientId, limit: 50 }, controller.signal),
      listCases({ view: 'closed', client: clientId, limit: 50 }, controller.signal),
    ])
      .then(([open, closed]) => {
        setCases([...open.cases, ...closed.cases]);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setCases([]);
          setNotice(toErrorNotice(error, 'Could not load cases'));
        }
      });
    return () => {
      controller.abort();
    };
  }, [canRead, clientId]);

  if (!canRead) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle>
          <h2 className="text-base font-semibold">Cases</h2>
        </CardTitle>
        {canOpen && (
          <Link to={newCasePath(clientId)} className={buttonVariants({ size: 'sm' })}>
            <Plus aria-hidden="true" />
            Open case
          </Link>
        )}
      </CardHeader>
      <CardContent>
        {notice !== null && <ErrorAlert notice={notice} />}
        {cases === null ? (
          <LoadingMessage>Loading cases…</LoadingMessage>
        ) : cases.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open or closed cases you can see.</p>
        ) : (
          <ul className="divide-y">
            {cases.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <Link
                    to={casePath(item.id)}
                    className="font-mono text-sm font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {item.caseCode}
                  </Link>{' '}
                  <span className="text-sm">
                    {item.serviceName}, tax year {item.taxYear}
                  </span>
                </span>
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  Due {formatDate(item.dueDate)}
                  <Badge variant={STATUS_KIND_BADGE[item.status.kind]}>{item.status.name}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
