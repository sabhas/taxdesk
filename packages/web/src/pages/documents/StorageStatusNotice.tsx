import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { TriangleAlert } from 'lucide-react';
import type { StorageConnection } from '@taxdesk/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { ROUTE_PATHS } from '../../routes.js';
import { useSession } from '../../session/session-context.js';
import { getStorageConnection } from '../../storage-api.js';
import { HEALTH_REASON_TEXT } from './document-format.js';

/**
 * Shown when document storage cannot take new uploads or opens (TD-404).
 * Administrators get a reconnect call to action; everyone else is told to
 * contact an administrator. Provider details are never shown.
 */
export function StorageStatusNotice() {
  const { can } = useSession();
  const manage = can('storage.manage');
  const [connection, setConnection] = useState<StorageConnection | null>(null);

  useEffect(() => {
    if (!manage) return;
    const controller = new AbortController();
    getStorageConnection(controller.signal)
      .then(setConnection)
      .catch(() => {
        // The notice still renders its generic call to action.
      });
    return () => {
      controller.abort();
    };
  }, [manage]);

  return (
    <Alert variant="warning" role="status" className="mb-4">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>
        <h3 className="text-sm font-semibold">Document storage is unavailable</h3>
      </AlertTitle>
      <AlertDescription className="space-y-2">
        {manage ? (
          <>
            <p>
              {connection?.healthReason != null
                ? HEALTH_REASON_TEXT[connection.healthReason]
                : 'Uploads and document opens are paused until storage is connected and healthy.'}
            </p>
            <Link
              to={ROUTE_PATHS.storage}
              className={buttonVariants({ size: 'sm', variant: 'outline' })}
            >
              {connection?.status === 'not_connected' ? 'Connect storage' : 'Reconnect storage'}
            </Link>
          </>
        ) : (
          <p>
            Document storage is unavailable — contact an administrator. Uploads and document opens
            are paused until it is restored.
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}
