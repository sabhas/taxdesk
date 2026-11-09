import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ROLE_KEYS, type RoleKey, type UserSummary } from '@taxdesk/shared';
import { createResetLink, inviteUser, listUsers, updateUser } from '../auth-client.js';
import { useSession } from '../session/session-context.js';
import {
  ErrorAlert,
  LoadingMessage,
  PermissionDenied,
  SuccessNotice,
  type ErrorNotice,
} from '../components/feedback.js';
import { toErrorNotice } from './error-notice.js';

const ROLE_LABELS: Record<RoleKey, string> = {
  administrator: 'Administrator',
  manager: 'Manager',
  consultant: 'Consultant',
  billing: 'Billing',
  read_only: 'Read-only',
};

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

  if (!can('users.manage')) {
    return <PermissionDenied />;
  }

  async function invite(event: FormEvent<HTMLFormElement>): Promise<void> {
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
      setSuccess(`Updated ${updated.username} to ${ROLE_LABELS[nextRole]}.`);
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
      <h1 id="users-heading">Users</h1>
      <p className="muted small">
        Activation and reset links are shown once for you to deliver. TaxDesk does not send email
        automatically.
      </p>
      {notice !== null && <ErrorAlert notice={notice} />}
      {success !== null && <SuccessNotice>{success}</SuccessNotice>}
      {link !== null && (
        <section className="card" aria-labelledby="one-time-link-heading">
          <h2 id="one-time-link-heading">One-time link</h2>
          <p>{link.label}</p>
          <p className="break-all">
            <a href={link.url}>{link.url}</a>
          </p>
          <p className="muted small">
            Expires {new Date(link.expiresAt).toLocaleString()}. The link works once.
          </p>
          <div className="button-row">
            <button type="button" onClick={() => void copyLink()}>
              Copy link
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setLink(null);
                setCopyStatus(null);
              }}
            >
              Dismiss
            </button>
          </div>
          {copyStatus !== null && (
            <p role="status" className="muted small">
              {copyStatus}
            </p>
          )}
        </section>
      )}

      <section className="card" aria-labelledby="invite-heading">
        <h2 id="invite-heading">Invite a user</h2>
        <form onSubmit={(event) => void invite(event)}>
          <div className="field">
            <label htmlFor="invite-username">Username</label>
            <input
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
            <p id="invite-username-help" className="muted small">
              3–32 letters, digits, dots, underscores, or hyphens. Usernames are permanent.
            </p>
          </div>
          <div className="field">
            <label htmlFor="invite-name">Display name</label>
            <input
              id="invite-name"
              autoComplete="off"
              required
              value={displayName}
              onChange={(event) => {
                setDisplayName(event.target.value);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="invite-role">Role</label>
            <select
              id="invite-role"
              value={role}
              onChange={(event) => {
                setRole(event.target.value as RoleKey);
              }}
            >
              {ROLE_KEYS.map((key) => (
                <option key={key} value={key}>
                  {ROLE_LABELS[key]}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" disabled={inviting} aria-busy={inviting}>
            {inviting ? 'Inviting…' : 'Send invitation'}
          </button>
        </form>
      </section>

      {users === null ? (
        <LoadingMessage>Loading users…</LoadingMessage>
      ) : users.length === 0 ? (
        <p className="muted">No users yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="muted small">Firm users and their current access</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">MFA</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const isSelf =
                  state.status === 'authenticated' && state.session.user.id === user.id;
                return (
                  <tr key={user.id}>
                    <td>
                      <strong>{user.displayName}</strong>
                      <div className="muted small">{user.username}</div>
                    </td>
                    <td>
                      <label className="visually-hidden" htmlFor={`role-${user.id}`}>
                        Role for {user.displayName}
                      </label>
                      <select
                        id={`role-${user.id}`}
                        value={user.roles[0] ?? 'read_only'}
                        disabled={busyUserId !== null}
                        onChange={(event) => {
                          void changeRole(user, event.target.value as RoleKey);
                        }}
                      >
                        {ROLE_KEYS.map((key) => (
                          <option key={key} value={key}>
                            {ROLE_LABELS[key]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>{user.status}</td>
                    <td>{user.mfaEnrolled ? 'Enabled' : 'Not set up'}</td>
                    <td>
                      <div className="button-row">
                        {!isSelf && (
                          <button
                            type="button"
                            className="secondary"
                            disabled={busyUserId !== null}
                            onClick={() => void toggleStatus(user)}
                          >
                            {user.status === 'deactivated' ? 'Reactivate' : 'Deactivate'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="secondary"
                          disabled={busyUserId !== null || user.status === 'deactivated'}
                          onClick={() => void resetLink(user)}
                        >
                          Reset link
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
