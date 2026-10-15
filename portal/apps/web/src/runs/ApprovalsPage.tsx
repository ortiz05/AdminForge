import { useQuery } from '@tanstack/react-query';
import {
  ArrowClockwiseIcon,
  EmptyState,
  IconButton,
  PageHeader,
  Panel,
  SealCheckIcon,
  SegmentedControl,
  Skeleton,
} from '@adminforge/ui';
import { useNavigate } from '@tanstack/react-router';
import { useMe } from '../lib/session';
import { Callout, isForbidden, QueryError, useDocumentTitle } from '../ops/ui';
import { approvalsQuery } from './approvals';
import { ApprovalCard } from './HumanTasks';

export interface ApprovalsSearch {
  status?: 'pending' | 'approved' | 'rejected' | 'expired';
}

/** Approvals inbox: run approval gates, write-capable schedules waiting for their second person, content publishes. */
export function ApprovalsPage({ search }: { search: ApprovalsSearch }) {
  const me = useMe();
  const navigate = useNavigate();
  const status = search.status ?? 'pending';
  const q = useQuery(approvalsQuery(status));
  useDocumentTitle('Approvals');
  const items = q.data?.items ?? [];
  const mine = items.filter((i) => i.requestedBy.toLowerCase() === me.user.upn.toLowerCase());
  const forMe = items.filter((i) => !mine.includes(i));
  const approver = me.roles.includes('Playbook.Approver') || me.roles.includes('Portal.Admin');

  return (
    <>
      <PageHeader
        eyebrow="Automation"
        title="Approvals"
        description="Two people for every consequential change: runs waiting at an approval gate, write-capable schedules, and content waiting to publish."
        actions={
          <>
            <SegmentedControl
              aria-label="Show approvals"
              value={status}
              onValueChange={(v) => void navigate({ to: '/approvals', search: { status: v as ApprovalsSearch['status'] }, replace: true })}
              options={[
                { value: 'pending', label: 'Waiting' },
                { value: 'approved', label: 'Approved' },
                { value: 'rejected', label: 'Rejected' },
              ]}
            />
            <IconButton label="Refresh" icon={<ArrowClockwiseIcon size={16} />} onClick={() => void q.refetch()} />
          </>
        }
      />
      {!approver && status === 'pending' && (
        <Callout tone="neutral" title="You can see requests, not decide them" className="mb-6">
          Deciding needs the Playbook Approver role. Requests you made are listed so you can follow them.
        </Callout>
      )}
      {q.isError && isForbidden(q.error) ? (
        <Panel>
          <EmptyState title="The approval inbox is for Playbook Approvers" icon={<SealCheckIcon size={20} />}>
            Runs you start that need approval show who can decide on the run page. Ask a Portal Admin if you should approve.
          </EmptyState>
        </Panel>
      ) : q.isError ? (
        <Panel>
          <QueryError title="Approvals didn’t load" error={q.error} onRetry={() => void q.refetch()} />
        </Panel>
      ) : q.isPending ? (
        <div className="flex flex-col gap-4" aria-busy="true">
          <Skeleton shape="block" className="h-40 w-full" />
          <Skeleton shape="block" className="h-40 w-full" />
        </div>
      ) : items.length === 0 ? (
        <Panel>
          <EmptyState title={status === 'pending' ? 'Nothing is waiting for a decision' : `No ${status} requests`} icon={<SealCheckIcon size={20} />}>
            {status === 'pending'
              ? 'When a run reaches an approval step, or someone enables a write-capable schedule, it shows up here.'
              : 'Decisions appear here once they are made.'}
          </EmptyState>
        </Panel>
      ) : (
        <div className="flex max-w-3xl flex-col gap-8">
          {forMe.length > 0 && (
            <section aria-label="Waiting for a decision" className="flex flex-col gap-3">
              <h2 className="af-eyebrow">
                {status === 'pending' ? 'Waiting for a decision' : 'Requests'} · {forMe.length}
              </h2>
              {forMe.map((i) => (
                <ApprovalCard key={i.id} item={i} />
              ))}
            </section>
          )}
          {mine.length > 0 && (
            <section aria-label="Requested by you" className="flex flex-col gap-3">
              <h2 className="af-eyebrow">Requested by you · {mine.length}</h2>
              {mine.map((i) => (
                <ApprovalCard key={i.id} item={i} />
              ))}
            </section>
          )}
        </div>
      )}
    </>
  );
}
