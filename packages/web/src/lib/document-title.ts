import { useEffect } from 'react';

export const APP_NAME = 'TaxDesk';

/** "Users" → "Users · TaxDesk". */
export function formatDocumentTitle(title?: string): string {
  return title === undefined ? APP_NAME : `${title} · ${APP_NAME}`;
}

/** Sets `document.title` while the calling screen is shown. */
export function useDocumentTitle(title?: string): void {
  useEffect(() => {
    document.title = formatDocumentTitle(title);
  }, [title]);
}

/** Component form of `useDocumentTitle`, for branches that return early. */
export function DocumentTitle({ title }: { title?: string }) {
  useDocumentTitle(title);
  return null;
}
