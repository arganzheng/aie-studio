// Model: web.TabActivityMarkers. Live activity a mounted session panel reports
// for its Tab, and the pure helpers TabBar / SessionList use to turn it into a
// marker. Kept free of React so it can be unit-tested.

export type TabActivity = {
  // The agent is mid-turn (panel status === 'thinking').
  generating: boolean;
  // The agent is blocked on the user: an unanswered ask_user_question form or
  // an open permission prompt (Devin only).
  awaitingInput: boolean;
};

export type ActivityMark = 'awaiting' | 'generating';

// awaitingInput outranks generating: a question is the thing the user has to
// act on, the spinner is just status.
export function activityMark(a: TabActivity | null | undefined): ActivityMark | null {
  if (!a) return null;
  if (a.awaitingInput) return 'awaiting';
  if (a.generating) return 'generating';
  return null;
}

export function sameActivity(a: TabActivity | undefined, b: TabActivity): boolean {
  return !!a && a.generating === b.generating && a.awaitingInput === b.awaitingInput;
}
