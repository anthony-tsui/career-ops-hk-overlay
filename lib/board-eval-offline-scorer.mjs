/**
 * Default board-eval scorer. It does not score.
 *
 * A live model call belongs to the existing career-ops evaluators
 * (openrouter-runner evaluate, batch, oferta). This module refuses to invent
 * the five dimensions when those evaluators are not in the call.
 */

export async function scorePosting() {
  const err = new Error(
    'career-ops scorer is offline. Refusing a hand-filled 5-dim score. '
    + 'Pass --report from an oferta, openrouter-runner evaluate, or batch report, '
    + 'or pass --scorer only for a test double.',
  );
  err.code = 'career-ops-scorer-offline';
  throw err;
}
