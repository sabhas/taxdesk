import { useCallback, useEffect, useRef, useState, type SubmitEvent } from 'react';
import { Check, Copy, LoaderCircle, UserPlus } from 'lucide-react';
import { ROLE_DEFINITIONS, ROLE_KEYS, type RoleKey, type UserSummary } from '@taxdesk/shared';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { createResetLink, inviteUser, listUsers, updateUser } from '../auth-client.js';
import { useSession } from '../session/session-context.js';
import {
  EmptyState,
  ErrorAlert,
  LoadingMessage,
  PermissionDenied,
  SuccessNotice,
  type ErrorNotice,
} from '../components/feedback.js';
import { PageHeader } from '../components/layout/PageHeader.js';
import { toErrorNotice } from './error-notice.js';

const roleName = (role: RoleKey): string => ROLE_DEFINITIONS[role].name;

interface OneTimeLink {
  readonly url: string;
  readonly expiresAt: string;
  readonly label: string;
}

export function UsersPage() {
  const { state, can } = useSession();
  const [users, setUsers] = useState<readonly UserSummary[] | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [link, setLink] = useState<OneTimeLink | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<RoleKey>('consultant');
  const [inviting, setInviting] = useState(false);
  // The dialog keeps showing the pending user while it animates closed, so
  // whether it is open is tracked separately from who it is about.
  const [pendingDeactivation, setPendingDeactivation] = useState<UserSummary | null>(null);
  const [deactivationOpen, setDeactivationOpen] = useState(false);
  // The dialog opens from state, not a Trigger, so focus return is explicit:
  // back to the row's status button (Deactivate, or Reactivate after success).
  // The button is looked up in the DOM when the dialog closes: a callback-ref
  // map is briefly empty while React re-attaches refs during that render.
  const focusReturnUserId = useRef<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await listUsers(signal);
      setUsers(result.users);
      setNotice(null);
    } catch (error) {
      if (signal?.aborted !== true) {
        setNotice(toErrorNotice(error, 'Could not load users'));
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  const deactivating = pendingDeactivation !== null && busyUserId === pendingDeactivation.id;

  if (!can('users.manage')) {
    return <PermissionDenied />;
  }

  async function invite(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setInviting(true);
    setNotice(null);
    setSuccess(null);
    try {
      const result = await inviteUser({ username, displayName, role });
      setLink({
        url: result.activationUrl,
        expiresAt: result.expiresAt,
        label: `Activation link for ${result.user.username}`,
      });
      setSuccess(
        `Invited ${result.user.username}. Copy the activation link and share it securely.`,
      );
      setUsername('');
      setDisplayName('');
      await load();
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not invite the user'));
    } finally {
      setInviting(false);
    }
  }

  async function changeRole(user: UserSummary, nextRole: RoleKey): Promise<void> {
    setBusyUserId(user.id);
    setNotice(null);
    setSuccess(null);
    try {
      const updated = await updateUser(user.id, { role: nextRole }, user.version);
      setUsers((current) =>
        current === null ? null : current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setSuccess(`Updated ${updated.username} to ${roleName(nextRole)}.`);
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not change the role'));
      await load();
    } finally {
      setBusyUserId(null);
    }
  }

  async function toggleStatus(user: UserSummary): Promise<void> {
    setBusyUserId(user.id);
    setNotice(null);
    setSuccess(null);
    const nextStatus = user.status === 'deactivated' ? 'active' : 'deactivated';
    try {
      const updated = await updateUser(user.id, { status: nextStatus }, user.version);
      setUsers((current) =>
        current === null ? null : current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setSuccess(
        nextStatus === 'deactivated'
          ? `Deactivated ${updated.username}. Their sessions were revoked.`
          : `Reactivated ${updated.username}.`,
      );
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not update the account'));
      await load();
    } finally {
      setBusyUserId(null);
    }
  }

  function requestDeactivation(user: UserSummary): void {
    focusReturnUserId.current = user.id;
    setPendingDeactivation(user);
    setDeactivationOpen(true);
  }

  async function confirmDeactivation(): Promise<void> {
    if (pendingDeactivation === null) {
      return;
    }
    // toggleStatus reports success or failure in the page notices.
    await toggleStatus(pendingDeactivation);
    setDeactivationOpen(false);
  }

  async function resetLink(user: UserSummary): Promise<void> {
    setBusyUserId(user.id);
    setNotice(null);
    setSuccess(null);
    try {
      const result = await createResetLink(user.id);
      setLink({
        url: result.activationUrl,
        expiresAt: result.expiresAt,
        label: `Password reset link for ${user.username}`,
      });
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not create a reset link'));
    } finally {
      setBusyUserId(null);
    }
  }

  async function copyLink(): Promise<void> {
    if (link === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(link.url);
      setCopyStatus('Link copied.');
    } catch {
      setCopyStatus('Copy failed. Select the link and copy it manually.');
    }
  }

  return (
    <section aria-labelledby="users-heading">
      <PageHeader
        id="users-heading"
        title="Users"
        description="Activation and reset links are shown once for you to deliver. TaxDesk does not send email automatically."
      />
      {notice !== null && <ErrorAlert notice={notice} />}
      {success !== null && <SuccessNotice>{success}</SuccessNotice>}
      {link !== null && (
        <Card aria-labelledby="one-time-link-heading" className="mb-6 ring-primary/30">
          <CardHeader>
            <CardTitle>
              <h2 id="one-time-link-heading">One-time link</h2>
            </CardTitle>
            <CardDescription>
              {link.label}. Expires {new Date(link.expiresAt).toLocaleString()}. The link works
              once.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="rounded-md bg-muted px-3 py-2 font-mono text-sm break-all">
              <a href={link.url} className="text-primary underline-offset-4 hover:underline">
                {link.url}
              </a>
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={() => void copyLink()}>
                {copyStatus === 'Link copied.' ? (
                  <Check aria-hidden="true" />
                ) : (
                  <Copy aria-hidden="true" />
                )}
                Copy link
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setLink(null);
                  setCopyStatus(null);
                }}
              >
                Dismiss
              </Button>
              {copyStatus !== null && (
                <p role="status" className="text-sm text-muted-foreground">
                  {copyStatus}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Card className="gap-0 py-0">
          {users === null ? (
            <div className="px-4">
              <LoadingMessage>Loading users…</LoadingMessage>
            </div>
          ) : users.length === 0 ? (
            <EmptyState title="No users yet">
              Invite the first staff member with the form.
            </EmptyState>
          ) : (
            <Table>
              <TableCaption className="sr-only">Firm users and their current access</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Name</TableHead>
                  <TableHead scope="col">Role</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">MFA</TableHead>
                  <TableHead scope="col" className="text-right">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => {
                  const isSelf =
                    state.status === 'authenticated' && state.session.user.id === user.id;
                  const deactivated = user.status === 'deactivated';
                  return (
                    <TableRow
                      key={user.id}
                      className={deactivated ? 'text-muted-foreground' : undefined}
                    >
                      <TableCell>
                        <span className="block font-medium text-foreground">
                          {user.displayName}
                        </span>
                        <span className="block text-xs text-muted-foreground">{user.username}</span>
                      </TableCell>
                      <TableCell>
                        <label className="sr-only" htmlFor={`role-${user.id}`}>
                          Role for {user.displayName}
                        </label>
                        <NativeSelect
                          id={`role-${user.id}`}
                          size="sm"
                          className="min-w-36"
                          value={user.roles[0] ?? 'read_only'}
                          disabled={busyUserId !== null}
                          onChange={(event) => {
                            void changeRole(user, event.target.value as RoleKey);
                          }}
                        >
                          {ROLE_KEYS.map((key) => (
                            <NativeSelectOption key={key} value={key}>
                              {roleName(key)}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      </TableCell>
                      <TableCell>
                        {deactivated ? (
                          <Badge variant="outline">Deactivated</Badge>
                        ) : user.status === 'active' ? (
                          <Badge variant="success">Active</Badge>
                        ) : (
                          <Badge variant="warning">Invited</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {user.mfaEnrolled ? (
                          <Badge variant="success">Enabled</Badge>
                        ) : (
                          <Badge variant="warning">Not set up</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1.5">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busyUserId !== null || deactivated}
                            onClick={() => void resetLink(user)}
                          >
                            Reset link
                          </Button>
                          {!isSelf && (
                            <Button
                              data-status-action={user.id}
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={busyUserId !== null}
                              onClick={() => {
                                if (deactivated) {
                                  void toggleStatus(user);
                                } else {
                                  requestDeactivation(user);
                                }
                              }}
                            >
                              {deactivated ? 'Reactivate' : 'Deactivate'}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Card>

        <Card aria-labelledby="invite-heading">
          <CardHeader>
            <CardTitle>
              <h2 id="invite-heading">Invite a user</h2>
            </CardTitle>
            <CardDescription>You get a one-time activation link to share.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={(event) => void invite(event)}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="invite-username">Username</FieldLabel>
                  <Input
                    id="invite-username"
                    type="text"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    minLength={3}
                    maxLength={32}
                    pattern="[A-Za-z0-9][A-Za-z0-9._\-]{1,30}[A-Za-z0-9]"
                    aria-describedby="invite-username-help"
                    value={username}
                    onChange={(event) => {
                      setUsername(event.target.value);
                    }}
                  />
                  <FieldDescription id="invite-username-help">
                    3–32 letters, digits, dots, underscores, or hyphens. Usernames are permanent.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="invite-name">Display name</FieldLabel>
                  <Input
                    id="invite-name"
                    autoComplete="off"
                    required
                    value={displayName}
                    onChange={(event) => {
                      setDisplayName(event.target.value);
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="invite-role">Role</FieldLabel>
                  <NativeSelect
                    id="invite-role"
                    className="w-full"
                    value={role}
                    onChange={(event) => {
                      setRole(event.target.value as RoleKey);
                    }}
                  >
                    {ROLE_KEYS.map((key) => (
                      <NativeSelectOption key={key} value={key}>
                        {roleName(key)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <FieldDescription>{ROLE_DEFINITIONS[role].description}</FieldDescription>
                </Field>
                <Button type="submit" disabled={inviting} aria-busy={inviting}>
                  {inviting ? (
                    <LoaderCircle aria-hidden="true" className="animate-spin" />
                  ) : (
                    <UserPlus aria-hidden="true" />
                  )}
                  {inviting ? 'Inviting…' : 'Send invitation'}
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </div>

      <AlertDialog
        open={deactivationOpen}
        onOpenChange={(open) => {
          if (!open && !deactivating) {
            setDeactivationOpen(false);
          }
        }}
        onOpenChangeComplete={(open) => {
          if (!open) {
            setPendingDeactivation(null);
          }
        }}
      >
        <AlertDialogContent
          finalFocus={() => {
            const userId = focusReturnUserId.current;
            const button =
              userId === null
                ? null
                : document.querySelector<HTMLElement>(`[data-status-action="${userId}"]`);
            return button ?? true;
          }}
        >
          {pendingDeactivation !== null && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Deactivate {pendingDeactivation.displayName}?</AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingDeactivation.displayName} will be signed out of every session and
                  can&apos;t sign in until an administrator reactivates them. Their records and
                  audit history are kept.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deactivating}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  type="button"
                  variant="destructive"
                  disabled={deactivating}
                  aria-busy={deactivating}
                  onClick={() => void confirmDeactivation()}
                >
                  {deactivating && <LoaderCircle aria-hidden="true" className="animate-spin" />}
                  Deactivate {pendingDeactivation.displayName}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
