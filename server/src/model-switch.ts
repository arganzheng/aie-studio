// The answer to a pending set_model control request, as the message the tabs
// get; null for any other event. Forgets the request once answered.
export function modelSwitchAnswer(pending: Map<string, string>, event: any):
  | { type: 'model_switched'; model: string }
  | { type: 'model_switch_failed'; model: string; message: string }
  | null {
  if (event?.type !== 'control_response') return null;
  const r = event.response;
  const id = typeof r?.request_id === 'string' ? r.request_id : null;
  const model = id ? pending.get(id) : undefined;
  if (!id || model === undefined) return null;
  pending.delete(id);
  if (r.subtype === 'success') return { type: 'model_switched', model };
  return { type: 'model_switch_failed', model, message: typeof r.error === 'string' && r.error ? r.error : 'claude refused the switch' };
}
