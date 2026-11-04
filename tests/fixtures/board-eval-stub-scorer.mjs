/**
 * Test double for board-eval. Not a scoring rubric.
 * CAREER_OPS_BOARD_EVAL_FIXTURE selects a fixed career-ops-shaped payload.
 */

const FULL = {
  cv_match: 4,
  north_star: 4.5,
  compensation: 3,
  culture: 4,
  red_flags: 2,
};

const EVIDENCE = {
  cv_match: 'supported',
  north_star: 'supported',
  compensation: 'partial',
  culture: 'supported',
  red_flags: 'supported',
};

export async function scorePosting() {
  const mode = process.env.CAREER_OPS_BOARD_EVAL_FIXTURE || 'ok';
  if (mode === 'missing') {
    return {
      score: 4.2,
      dimensions: { cv_match: 4, north_star: 4, culture: 4, red_flags: 2 },
    };
  }
  if (mode === 'override') {
    return { score: 4.2, manualScore: 1, dimensions: { ...FULL } };
  }
  if (mode === 'extra') {
    return {
      score: 4.2,
      dimensions: { ...FULL, level_fit: 1 },
      score_evidence: EVIDENCE,
      legitimacy_tier: 'Proceed with Caution',
    };
  }
  if (mode === 'agency') {
    return {
      score: 3.8,
      dimensions: { cv_match: 3, north_star: 3, compensation: 3, culture: 3, red_flags: 3 },
      legitimacy_tier: 'Proceed with Caution',
    };
  }
  return {
    score: 4.2,
    dimensions: { ...FULL },
    score_evidence: EVIDENCE,
    legitimacy_tier: 'Proceed with Caution',
  };
}
