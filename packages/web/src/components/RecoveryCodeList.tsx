import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * One-time recovery codes in a grid with a copy-all action. Codes are only
 * ever held in memory and the clipboard; nothing is persisted.
 */
export function RecoveryCodeList({ codes, label }: { codes: readonly string[]; label: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  return (
    <div className="rounded-xl border bg-card p-4">
      <ul
        aria-label={label}
        className="grid grid-cols-1 gap-2 font-mono text-sm sm:grid-cols-2 md:grid-cols-3"
      >
        {codes.map((code) => (
          <li key={code} className="rounded-md bg-muted px-3 py-2 text-center">
            <code>{code}</code>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(codes.join('\n')).then(
              () => {
                setStatus('copied');
              },
              () => {
                setStatus('failed');
              },
            );
          }}
        >
          {status === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          Copy all codes
        </Button>
        <p role="status" className="text-sm text-muted-foreground">
          {status === 'copied' && 'Codes copied.'}
          {status === 'failed' && 'Copy failed. Select the codes and copy them manually.'}
        </p>
      </div>
    </div>
  );
}
