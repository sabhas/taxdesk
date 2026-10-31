import { describe, expect, it } from 'vitest';
import {
  ONEDRIVE_SPIKE_REQUIRED_SCENARIOS,
  type OnedriveSpikeScenario,
  type OnedriveSpikeScenarioResult,
  type OnedriveSpikeScenarioStatus,
} from '@taxdesk/shared';
import { evaluateSpikeResults } from './spike-evaluation.js';

function result(
  scenario: OnedriveSpikeScenario,
  status: OnedriveSpikeScenarioStatus,
): OnedriveSpikeScenarioResult {
  return {
    scenario,
    status,
    durationMs: 10,
    detail: `${scenario} ${status}`,
  };
}

function allPassed(): OnedriveSpikeScenarioResult[] {
  return ONEDRIVE_SPIKE_REQUIRED_SCENARIOS.map((scenario) => result(scenario, 'passed'));
}

describe('evaluateSpikeResults', () => {
  it('passes without a blocking decision when every required scenario passed', () => {
    const evaluation = evaluateSpikeResults(allPassed());
    expect(evaluation.outcome).toBe('passed');
    expect(evaluation.blockingDecision).toEqual({ raised: false });
  });

  it('ignores order and duplicate-free subsets when deciding pass', () => {
    const reversed = [...allPassed()].reverse();
    expect(evaluateSpikeResults(reversed).outcome).toBe('passed');
  });

  it('raises a blocking decision when any scenario failed', () => {
    const results = allPassed().map((entry) =>
      entry.scenario === 'upload_interruption' ? result(entry.scenario, 'failed') : entry,
    );
    const evaluation = evaluateSpikeResults(results);
    expect(evaluation.outcome).toBe('failed');
    expect(evaluation.blockingDecision.raised).toBe(true);
    if (!evaluation.blockingDecision.raised) throw new Error('expected a raised decision');
    expect(evaluation.blockingDecision.reason).toContain('upload_interruption');
    expect(evaluation.blockingDecision.requiredAction).toContain('Do not start Epic 4');
  });

  it('prefers a failure over a missing scenario', () => {
    const evaluation = evaluateSpikeResults([
      result('consent', 'failed'),
      result('token_refresh', 'passed'),
    ]);
    expect(evaluation.outcome).toBe('failed');
  });

  it('blocks when a required scenario was skipped', () => {
    const results = allPassed().map((entry) =>
      entry.scenario === 'revoked_consent' ? result(entry.scenario, 'skipped') : entry,
    );
    const evaluation = evaluateSpikeResults(results);
    expect(evaluation.outcome).toBe('incomplete');
    expect(evaluation.blockingDecision.raised).toBe(true);
    if (!evaluation.blockingDecision.raised) throw new Error('expected a raised decision');
    expect(evaluation.blockingDecision.reason).toContain('revoked_consent');
  });

  it('blocks when a required scenario was never recorded', () => {
    const evaluation = evaluateSpikeResults([result('consent', 'passed')]);
    expect(evaluation.outcome).toBe('incomplete');
    expect(evaluation.blockingDecision.raised).toBe(true);
    if (!evaluation.blockingDecision.raised) throw new Error('expected a raised decision');
    expect(evaluation.blockingDecision.reason).toContain('token_refresh');
    expect(evaluation.blockingDecision.reason).not.toContain('not verified: consent');
  });

  it('blocks when no results were recorded at all', () => {
    const evaluation = evaluateSpikeResults([]);
    expect(evaluation.outcome).toBe('incomplete');
    expect(evaluation.blockingDecision.raised).toBe(true);
  });

  it('lists unverified scenarios in the required order', () => {
    const evaluation = evaluateSpikeResults([
      result('consent', 'passed'),
      result('revoked_consent', 'skipped'),
      result('download', 'skipped'),
    ]);
    if (!evaluation.blockingDecision.raised) throw new Error('expected a raised decision');
    expect(evaluation.blockingDecision.reason).toBe(
      'OneDrive Personal scenario(s) not verified: token_refresh, upload, download, upload_interruption, revoked_consent.',
    );
  });
});
