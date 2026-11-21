import { describe, expect, it } from 'vitest';
import { foldPlan, planFromList, planSummary, planToolSummary, type PlanToolCall } from '../plan';

const todo = (todos: any[]): PlanToolCall => ({ name: 'TodoWrite', input: { todos } });

describe('foldPlan', () => {
  it('is null until a plan tool runs', () => {
    expect(foldPlan([])).toBeNull();
    expect(foldPlan([{ name: 'Bash', input: { command: 'ls' } }])).toBeNull();
  });

  it('TodoWrite replaces the whole list each time', () => {
    const plan = foldPlan([
      todo([{ content: 'a', status: 'pending', activeForm: 'Doing a' }]),
      todo([
        { content: 'a', status: 'completed', activeForm: 'Doing a' },
        { content: 'b', status: 'in_progress', activeForm: 'Doing b' },
      ]),
    ]);
    expect(plan).toEqual([
      { text: 'a', active: 'Doing a', status: 'completed' },
      { text: 'b', active: 'Doing b', status: 'in_progress' },
    ]);
  });

  it('an empty TodoWrite clears the list', () => {
    expect(foldPlan([todo([{ content: 'a', status: 'pending' }]), todo([])])).toEqual([]);
  });

  it('TaskCreate takes the id from its result, else counts from 1', () => {
    const plan = foldPlan([
      { name: 'TaskCreate', input: { subject: 'one' }, output: 'Task #7 created successfully: one' },
      { name: 'TaskCreate', input: { subject: 'two', activeForm: 'Doing two' } },
    ]);
    expect(plan).toEqual([
      { id: '7', text: 'one', active: undefined, status: 'pending' },
      { id: '8', text: 'two', active: 'Doing two', status: 'pending' },
    ]);
  });

  it('TaskUpdate patches status and text, and deletes', () => {
    const plan = foldPlan([
      { name: 'TaskCreate', input: { subject: 'one' } },
      { name: 'TaskCreate', input: { subject: 'two' } },
      { name: 'TaskCreate', input: { subject: 'three' } },
      { name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
      { name: 'TaskUpdate', input: { taskId: '2', status: 'in_progress', subject: 'two!' } },
      { name: 'TaskUpdate', input: { taskId: '3', status: 'deleted' } },
      { name: 'TaskUpdate', input: { taskId: '99', status: 'completed' } },
    ]);
    expect(plan?.map((x) => [x.id, x.text, x.status])).toEqual([
      ['1', 'one', 'completed'],
      ['2', 'two!', 'in_progress'],
    ]);
  });

  it('continues from a starting plan (the part of the transcript not loaded)', () => {
    const start = foldPlan([{ name: 'TaskCreate', input: { subject: 'one' }, output: 'Task #1 created' }]);
    const plan = foldPlan([{ name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }], start);
    expect(plan?.[0].status).toBe('completed');
    expect(start?.[0].status).toBe('pending');
  });
});

describe('planFromList', () => {
  it('reads Devin plan entries and drops empty ones', () => {
    expect(planFromList([{ content: 'x', status: 'in_progress' }, { content: '' }, { status: 'weird', content: 'y' }])).toEqual([
      { text: 'x', active: undefined, status: 'in_progress' },
      { text: 'y', active: undefined, status: 'pending' },
    ]);
    expect(planFromList(undefined)).toBeNull();
  });
});

describe('planSummary', () => {
  it('counts done and picks the item in progress, else the next pending', () => {
    const plan = planFromList([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
      { content: 'c', status: 'in_progress' },
    ])!;
    expect(planSummary(plan)).toEqual({ done: 1, total: 3, current: plan[2] });
    expect(planSummary(plan.slice(0, 2)).current).toBe(plan[1]);
    expect(planSummary(plan.slice(0, 1)).current).toBeNull();
  });
});

describe('planToolSummary', () => {
  it('names the task and the change', () => {
    expect(planToolSummary('TaskCreate', { subject: 'Write tests' })).toBe('Write tests');
    expect(planToolSummary('TaskUpdate', { taskId: '2', status: 'in_progress' })).toBe('#2 → in progress');
    expect(planToolSummary('TaskUpdate', { taskId: '2', subject: 'Renamed' })).toBe('#2 Renamed');
    expect(planToolSummary('TodoWrite', { todos: [{}, {}] })).toBe('2 todos');
    expect(planToolSummary('Bash', { command: 'ls' })).toBe('');
  });
});
