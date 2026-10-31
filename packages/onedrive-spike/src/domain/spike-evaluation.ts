import {
  ONEDRIVE_SPIKE_REQUIRED_SCENARIOS,
  type OnedriveSpikeBlockingDecision,
  type OnedriveSpikeOutcome,
  type OnedriveSpikeScenario,
  type OnedriveSpikeScenarioResult,
} from '@taxdesk/shared';

export interface SpikeEvaluation {
  readonly outcome: OnedriveSpikeOutcome;
  readonly blockingDecision: OnedriveSpikeBlockingDecision;
}

/**
 * Turns recorded scenario results into the spike outcome and the blocking
 * decision required by TD-005.
 *
 * The rule is deliberately unforgiving: Epic 4 document storage may only depend
 * on OneDrive Personal after every required scenario has *passed*. A failed
 * scenario is a hard block, and a scenario that was never verified (missing or
 * skipped) is also a block, because "not proven" is not "proven safe".
 */
export function evaluateSpikeResults(
  results: readonly OnedriveSpikeScenarioResult[],
): SpikeEvaluation {
  const failed = results.filter((result) => result.status === 'failed');
  if (failed.length > 0) {
    return {
      outcome: 'failed',
      blockingDecision: {
        raised: true,
        reason: `OneDrive Personal scenario(s) failed: ${formatScenarios(failed.map((result) => result.scenario))}.`,
        requiredAction:
          'Do not start Epic 4 document storage or any production OneDrive adapter work. Investigate the recorded failure, fix the cause or renegotiate the storage decision, and re-run the spike before depending on OneDrive.',
      },
    };
  }

  const verified = new Set(
    results.filter((result) => result.status === 'passed').map((result) => result.scenario),
  );
  const unverified = ONEDRIVE_SPIKE_REQUIRED_SCENARIOS.filter(
    (scenario) => !verified.has(scenario),
  );
  if (unverified.length > 0) {
    return {
      outcome: 'incomplete',
      blockingDecision: {
        raised: true,
        reason: `OneDrive Personal scenario(s) not verified: ${formatScenarios(unverified)}.`,
        requiredAction:
          'Do not start Epic 4 document storage or any production OneDrive adapter work. Run the spike against the intended Personal account, record every required scenario, and quote the committed evidence in the sprint review notes.',
      },
    };
  }

  return { outcome: 'passed', blockingDecision: { raised: false } };
}

function formatScenarios(scenarios: readonly OnedriveSpikeScenario[]): string {
  const ordered = ONEDRIVE_SPIKE_REQUIRED_SCENARIOS.filter((scenario) =>
    scenarios.includes(scenario),
  );
  return ordered.join(', ');
}
