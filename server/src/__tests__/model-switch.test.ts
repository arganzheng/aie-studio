import { describe, expect, it } from 'vitest';
import { modelSwitchAnswer } from '../model-switch.js';

describe('modelSwitchAnswer', () => {
  it('answers a pending set_model and forgets it', () => {
    const pending = new Map([['setmodel-1', 'fable']]);
    expect(modelSwitchAnswer(pending, { type: 'control_response', response: { subtype: 'success', request_id: 'setmodel-1' } }))
      .toEqual({ type: 'model_switched', model: 'fable' });
    expect(pending.size).toBe(0);
  });

  it('reports a refusal with its reason', () => {
    const pending = new Map([['setmodel-2', 'nope']]);
    expect(modelSwitchAnswer(pending, { type: 'control_response', response: { subtype: 'error', request_id: 'setmodel-2', error: 'unknown model' } }))
      .toEqual({ type: 'model_switch_failed', model: 'nope', message: 'unknown model' });
  });

  it('ignores other events and other requests', () => {
    const pending = new Map([['setmodel-3', 'opus']]);
    expect(modelSwitchAnswer(pending, { type: 'assistant' })).toBeNull();
    expect(modelSwitchAnswer(pending, { type: 'control_response', response: { subtype: 'success', request_id: 'other' } })).toBeNull();
    expect(pending.size).toBe(1);
  });
});
