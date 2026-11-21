import { useEffect, useState } from 'react';
import type { ClientListItem } from '@taxdesk/shared';
import { Field, FieldLabel } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { listClients } from '../../client-api.js';
import { useSession } from '../../session/session-context.js';

/**
 * "Group" filter (TD-207) shared by the client, case, and invoice lists. The
 * options are group heads with at least one member the user can see; the
 * server applies the filter and leaves out hidden members. Like the other
 * pickers it lists the first 100, and keeps a selected group from a link.
 */
export function GroupFilterField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { can } = useSession();
  const canReadClients = can('clients.read');
  const [heads, setHeads] = useState<readonly ClientListItem[]>([]);

  useEffect(() => {
    if (!canReadClients) {
      return;
    }
    const controller = new AbortController();
    void listClients({ grouping: 'heads', state: 'all', limit: 100 }, controller.signal)
      .then((result) => {
        setHeads(result.clients);
      })
      .catch(() => {
        // The filter falls back to "Any group"; the list itself still works.
      });
    return () => {
      controller.abort();
    };
  }, [canReadClients]);

  if (!canReadClients) {
    return null;
  }

  return (
    <Field>
      <FieldLabel htmlFor={id}>Group</FieldLabel>
      <NativeSelect
        id={id}
        className="w-full"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <NativeSelectOption value="">Any group</NativeSelectOption>
        {value.length > 0 && !heads.some((head) => head.id === value) && (
          <NativeSelectOption value={value}>Selected group</NativeSelectOption>
        )}
        {heads.map((head) => (
          <NativeSelectOption key={head.id} value={head.id}>
            {head.displayName} ({head.clientCode})
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  );
}
