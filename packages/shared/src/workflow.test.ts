import { describe, expect, it } from 'vitest';
import {
  STARTER_WORKFLOW_DEFINITION,
  WorkflowDefinitionSchema,
  validateWorkflowDefinition,
  workflowKeyFrom,
  type WorkflowDefinition,
} from './workflow.js';

function clone(definition: WorkflowDefinition = STARTER_WORKFLOW_DEFINITION): WorkflowDefinition {
  return structuredClone(definition);
}

function messages(definition: WorkflowDefinition): string[] {
  return validateWorkflowDefinition(definition).map((issue) => issue.message);
}

describe('workflow definition validation (TD-302)', () => {
  it('accepts the starter template', () => {
    expect(WorkflowDefinitionSchema.parse(STARTER_WORKFLOW_DEFINITION)).toEqual(
      STARTER_WORKFLOW_DEFINITION,
    );
    expect(validateWorkflowDefinition(STARTER_WORKFLOW_DEFINITION)).toEqual([]);
  });

  it('requires exactly one initial status', () => {
    const none = clone();
    none.statuses = none.statuses.map((status) => ({ ...status, initial: false }));
    expect(messages(none)).toContain('Mark exactly one status as the initial status.');

    const two = clone();
    two.statuses[1] = { ...two.statuses[1]!, initial: true };
    expect(messages(two)).toContain('Only one status can be the initial status.');
  });

  it('requires the initial status to be open', () => {
    const definition = clone();
    definition.statuses = definition.statuses.map((status) => ({
      ...status,
      initial: status.key === 'filed',
    }));
    expect(messages(definition)).toContain('The initial status must be an open status.');
  });

  it('rejects unreachable statuses', () => {
    const definition = clone();
    definition.statuses.push({
      key: 'orphan',
      name: 'Orphan',
      kind: 'open',
      initial: false,
      requiresChecklistComplete: false,
    });
    definition.transitions.push({ from: 'orphan', to: 'completed' });
    expect(messages(definition)).toContain('"Orphan" cannot be reached from the initial status.');
  });

  it('rejects dead-end active statuses and outgoing transitions from terminal statuses', () => {
    const definition = clone();
    definition.transitions = definition.transitions.filter(
      (transition) => transition.from !== 'filed',
    );
    definition.transitions.push({ from: 'completed', to: 'intake' });
    const found = messages(definition);
    expect(found).toContain('"Filed" has no way forward. Add a transition out of it.');
    expect(found).toContain('"Completed" ends the case, so it cannot move to another status.');
  });

  it('requires filed and completed statuses to gate on the checklist', () => {
    const definition = clone();
    definition.statuses = definition.statuses.map((status) =>
      status.kind === 'filed' ? { ...status, requiresChecklistComplete: false } : status,
    );
    expect(messages(definition)).toContain(
      '"Filed" is a filed status, so it must require a complete checklist.',
    );
  });

  it('rejects unknown, duplicate, and self transitions and duplicate keys', () => {
    const definition = clone();
    definition.transitions.push({ from: 'intake', to: 'missing' });
    definition.transitions.push({ from: 'intake', to: 'collecting_documents' });
    definition.transitions.push({ from: 'intake', to: 'intake' });
    definition.checklist.push({ ...definition.checklist[0]! });
    const found = messages(definition);
    expect(found).toContain('The transition ends at an unknown status "missing".');
    expect(found).toContain('This transition is listed more than once.');
    expect(found).toContain('A transition must move to a different status.');
    expect(found).toContain('The checklist key "identity_document" is used more than once.');
  });

  it('requires a completed status', () => {
    const definition = clone();
    definition.statuses = definition.statuses.filter((status) => status.kind !== 'completed');
    definition.transitions = definition.transitions.filter(
      (transition) => transition.to !== 'completed',
    );
    expect(messages(definition)).toContain('Add at least one completed status.');
  });

  it('enforces key format and limits structurally', () => {
    const definition = clone();
    expect(
      WorkflowDefinitionSchema.safeParse({
        ...definition,
        statuses: [{ ...definition.statuses[0], key: 'Bad Key' }],
      }).success,
    ).toBe(false);
    expect(WorkflowDefinitionSchema.safeParse({ ...definition, extra: true }).success).toBe(false);
  });

  it('derives keys from names', () => {
    expect(workflowKeyFrom('In review')).toBe('in_review');
    expect(workflowKeyFrom('  2026 Filing! ')).toBe('s_2026_filing');
    expect(workflowKeyFrom('***')).toBe('item');
  });
});
