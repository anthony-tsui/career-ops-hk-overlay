/**
 * lib/hk-scan-filters.mjs — HK Slice D: employment type + agency/Big4 gates.
 *
 * Scan path: annotate pipeline rows (never silent-drop contract/temp).
 * Eval path: suggest tracker status Review via hk-* tags in Notes (merge-tracker).
 *
 * Config keys live in portals.yml (see templates/portals.hk.example.yml).
 */

/** @typedef {'permanent_ft'|'contract_temp'|'unknown'} EmploymentClass */

const DEFAULT_CONTRACT_PATTERNS = [
  /\bcontract(?:or|ual)?\b/i,
  /\btemporary\b/i,
  /\btemp(?:\s+role|\s+position|\s+staff)?\b/i,
  /\bfixed[-\s]?term\b/i,
  /\bfreelance\b/i,
  /\bconsulting agreement\b/i,
  /\bcontract position\b/i,
  /\b12[-\s]?month contract\b/i,
];

const DEFAULT_PART_TIME_PATTERNS = [
  /\bpart[-\s]?time\b/i,
  /\bjob share\b/i,
];

const DEFAULT_PERMANENT_PATTERNS = [
  /\bpermanent\b/i,
  /\bfull[-\s]?time\b/i,
  /\b正社員\b/,
];

/** @type {Record<string, string[]>} Canonical Big4 alias sets (seed + portals.yml names map here). */
export const BIG4_SEED_ALIASES = {
  deloitte: ['Deloitte'],
  kpmg: ['KPMG'],
  pwc: ['PwC', 'PricewaterhouseCoopers', 'Price Waterhouse', 'Pricewaterhouse Coopers'],
  ey: ['EY', 'Ernst & Young', 'Ernst Young'],
};

const DEFAULT_RECRUITER_WATCH = [
  'michael page',
  'hays',
  'robert walters',
  'morgan mckinley',
  'randstad',
  'ambition',
  'oliver james',
];

const DEFAULT_AI_SIGNALS = [
  'ai transformation',
  'artificial intelligence transformation',
  'digital transformation',
  'genai',
  'generative ai',
  'customer ai',
  'machine learning',
  'solutions architect',
  'solutions delivery',
  'delivery lead',
  'transformation lead',
  'word:ai',
];

const HK_TAG_PREFIX = 'hk-';

/**
 * @param {object} portalsConfig
 * @returns {boolean}
 */
export function hkFiltersActive(portalsConfig = {}) {
  if (!portalsConfig || typeof portalsConfig !== 'object') return false;
  if (portalsConfig.employment_filter && portalsConfig.employment_filter.enabled !== false) {
    return true;
  }
  if (portalsConfig.agency_filter && portalsConfig.agency_filter.enabled !== false) {
    return true;
  }
  const target = Number(portalsConfig.salary_filter?.target ?? 0);
  return Number.isFinite(target) && target > 0;
}

/**
 * @param {unknown} list
 * @returns {string[]}
 */
function normalizeKeywordList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean);
}

/**
 * @param {string} haystack
 * @param {string[]} needles
 * @returns {boolean}
 */
function textMatchesAny(haystack, needles) {
  const lower = haystack.toLowerCase();
  for (const raw of needles) {
    const k = raw.trim();
    if (!k) continue;
    if (k.startsWith('word:')) {
      const word = k.slice(5).trim();
      if (!word) continue;
      const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(haystack)) return true;
      continue;
    }
    if (lower.includes(k.toLowerCase())) return true;
  }
  return false;
}

/**
 * @param {string} company
 * @returns {string}
 */
function normalizeCompanyKey(company) {
  return String(company ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * @param {string} workTypeRaw
 * @returns {EmploymentClass}
 */
export function classifyWorkTypeLabel(workTypeRaw) {
  const wt = String(workTypeRaw ?? '').trim().toLowerCase();
  if (!wt) return 'unknown';
  if (/(contract|temporary|temp|casual|freelance|fixed)/.test(wt)) return 'contract_temp';
  if (/(part)/.test(wt) && /time/.test(wt)) return 'contract_temp';
  if (/(full|permanent|perm)/.test(wt)) return 'permanent_ft';
  return 'unknown';
}

/**
 * @param {{ workType?: string, title?: string, description?: string, teaser?: string }} job
 * @param {object} [employmentFilter]
 * @returns {{ class: EmploymentClass, reason: string }}
 */
export function classifyEmployment(job, employmentFilter = {}) {
  const workTypes = Array.isArray(job.workType)
    ? job.workType
    : job.workType
      ? [job.workType]
      : [];
  for (const wt of workTypes) {
    const fromWt = classifyWorkTypeLabel(wt);
    if (fromWt !== 'unknown') {
      return { class: fromWt, reason: `workType:${wt}` };
    }
  }

  const blob = [job.title, job.description, job.teaser].filter(Boolean).join('\n');
  const customReview = normalizeKeywordList(employmentFilter.review_patterns).map(
    (p) => new RegExp(p, 'i'),
  );
  const reviewPatterns = [...customReview, ...DEFAULT_CONTRACT_PATTERNS, ...DEFAULT_PART_TIME_PATTERNS];
  if (blob) {
    for (const re of reviewPatterns) {
      if (re.test(blob)) return { class: 'contract_temp', reason: 'text:contract/temp' };
    }
  }

  const preferPatterns = normalizeKeywordList(employmentFilter.prefer_patterns);
  const permanentRes = [
    ...preferPatterns.map((p) => new RegExp(p, 'i')),
    ...DEFAULT_PERMANENT_PATTERNS,
  ];
  if (blob) {
    for (const re of permanentRes) {
      if (re.test(blob)) return { class: 'permanent_ft', reason: 'text:permanent-ft' };
    }
  }

  return { class: 'unknown', reason: 'unknown' };
}

/**
 * Resolve configured Big4 brand names to alias lists (never bare substring on tokens like "ey").
 * @param {object} agencyFilter
 * @returns {string[][]}
 */
export function resolveBig4AliasGroups(agencyFilter = {}) {
  const configured = normalizeKeywordList(agencyFilter.big4);
  const names = configured.length
    ? configured
    : ['Deloitte', 'PwC', 'EY', 'KPMG'];
  /** @type {string[][]} */
  const groups = [];
  for (const name of names) {
    const group = lookupBig4AliasGroup(name);
    groups.push(group ?? [name]);
  }
  return groups;
}

/**
 * @param {string} configuredName — one entry from agency_filter.big4
 * @returns {string[] | null}
 */
export function lookupBig4AliasGroup(configuredName) {
  const k = normalizeCompanyKey(configuredName);
  if (!k) return null;
  if (k.includes('deloitte')) return BIG4_SEED_ALIASES.deloitte;
  if (k === 'kpmg' || k.includes('kpmg')) return BIG4_SEED_ALIASES.kpmg;
  if (k === 'pwc' || k.includes('pwc') || k.includes('pricewaterhouse') || k.includes('price waterhouse')) {
    return BIG4_SEED_ALIASES.pwc;
  }
  if (k === 'ey' || k.includes('ernst')) return BIG4_SEED_ALIASES.ey;
  return null;
}

/**
 * Safe company match: short aliases (≤3 chars) match whole tokens only — never `includes('ey')` on Honeywell.
 * Longer aliases match normalized contiguous phrases.
 *
 * @param {string} normalizedCompanyKey — from normalizeCompanyKey(company)
 * @param {string} alias
 * @returns {boolean}
 */
export function companyMatchesBrandAlias(normalizedCompanyKey, alias) {
  const phrase = normalizeCompanyKey(alias);
  if (!phrase || !normalizedCompanyKey) return false;
  if (phrase.length <= 3) {
    const tokens = normalizedCompanyKey.split(/\s+/).filter(Boolean);
    return normalizedCompanyKey === phrase || tokens.includes(phrase);
  }
  return normalizedCompanyKey.includes(phrase);
}

/**
 * @param {string} normalizedCompanyKey
 * @param {string[]} aliases
 * @returns {boolean}
 */
export function companyMatchesAnyAlias(normalizedCompanyKey, aliases) {
  return aliases.some((a) => companyMatchesBrandAlias(normalizedCompanyKey, a));
}

/**
 * @param {string} normalizedCompanyKey
 * @param {string[][]} aliasGroups
 * @returns {boolean}
 */
export function isBig4CompanyKey(normalizedCompanyKey, aliasGroups) {
  if (!normalizedCompanyKey) return false;
  return aliasGroups.some((group) => companyMatchesAnyAlias(normalizedCompanyKey, group));
}

/**
 * @param {object} agencyFilter
 * @returns {{ big4Groups: string[][], agencies: string[], aiSignals: string[] }}
 */
export function resolveAgencyLists(agencyFilter = {}) {
  const agencyRaw = normalizeKeywordList(agencyFilter.agency_companies);
  return {
    big4Groups: resolveBig4AliasGroups(agencyFilter),
    agencies: (agencyRaw.length ? agencyRaw : DEFAULT_RECRUITER_WATCH.slice()),
    aiSignals: normalizeKeywordList(agencyFilter.ai_signals).length
      ? normalizeKeywordList(agencyFilter.ai_signals)
      : DEFAULT_AI_SIGNALS.slice(),
  };
}

/**
 * @param {{ company?: string, title?: string, description?: string, teaser?: string }} job
 * @param {object} [agencyFilter]
 * @returns {{ channel: 'in-house'|'agency'|'big4'|'unknown', demote: boolean, aiSignal: boolean, reason: string }}
 */
export function evaluateAgencyGate(job, agencyFilter = {}) {
  if (agencyFilter.enabled === false) {
    return { channel: 'unknown', demote: false, aiSignal: false, reason: 'disabled' };
  }
  const lists = resolveAgencyLists(agencyFilter);
  const key = normalizeCompanyKey(job.company || '');
  const blob = [job.title, job.description, job.teaser].filter(Boolean).join('\n');
  const aiSignal = textMatchesAny(blob, lists.aiSignals);

  let channel = 'in-house';
  if (isBig4CompanyKey(key, lists.big4Groups)) channel = 'big4';
  else if (lists.agencies.some((a) => companyMatchesBrandAlias(key, a))) {
    channel = 'agency';
  } else if (!key) {
    channel = 'unknown';
  }

  const demoteUnlessAi = agencyFilter.demote_unless_ai !== false;
  const demote =
    demoteUnlessAi && (channel === 'agency' || channel === 'big4') && !aiSignal;

  let reason = 'in-house';
  if (channel === 'big4') reason = demote ? 'big4-no-ai-signal' : 'big4-ai-signal';
  else if (channel === 'agency') reason = demote ? 'agency-no-ai-signal' : 'agency-ai-signal';

  return { channel, demote, aiSignal, reason };
}

/**
 * @param {{ min?: number, max?: number, currency?: string, target?: number }} salaryFilter
 * @param {{ min?: number, max?: number, currency?: string } | null | undefined} salary
 * @returns {string} empty or hk-salary-rank:… tag (rank-only; never filters)
 */
export function formatSalaryRankTag(salaryFilter, salary) {
  const target = Number(salaryFilter?.target ?? 0);
  if (!Number.isFinite(target) || target <= 0) return '';
  if (!salary) return `${HK_TAG_PREFIX}salary-rank:unknown`;

  const jobMin = salary.min ?? salary.max ?? null;
  const jobMax = salary.max ?? salary.min ?? null;
  const jobVal = jobMax != null ? jobMax : jobMin;
  if (jobVal == null) return `${HK_TAG_PREFIX}salary-rank:unknown`;

  if (jobVal >= target) return `${HK_TAG_PREFIX}salary-rank:at-target`;
  const floor = Number(salaryFilter?.min ?? 0);
  if (floor > 0 && jobVal >= floor) return `${HK_TAG_PREFIX}salary-rank:above-floor-below-target`;
  return `${HK_TAG_PREFIX}salary-rank:below-floor`;
}

/**
 * Merge hk tags into a note string (idempotent on tag keys).
 * @param {string} existing
 * @param {string[]} tags
 */
export function mergeHkTags(existing, tags) {
  const base = String(existing ?? '').trim();
  const kept = base
    .split(/\s*;\s*/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith(HK_TAG_PREFIX));
  const next = [...kept, ...tags.filter(Boolean)];
  return next.join('; ');
}

/**
 * Scan-time decoration: mutates job.note and job.hkSuggestedStatus.
 * Never sets a drop flag.
 *
 * @param {Record<string, unknown>} job
 * @param {object} portalsConfig
 */
export function decorateHkScanJob(job, portalsConfig = {}) {
  const employmentFilter = portalsConfig.employment_filter;
  const agencyFilter = portalsConfig.agency_filter;
  const salaryFilter = portalsConfig.salary_filter;

  const tags = [];
  let suggested = null;

  if (employmentFilter?.enabled !== false && employmentFilter) {
    const { class: empClass, reason } = classifyEmployment(job, employmentFilter);
    job.hkEmploymentClass = empClass;
    if (empClass === 'contract_temp') {
      tags.push(`${HK_TAG_PREFIX}employment:contract-temp`);
      tags.push(`${HK_TAG_PREFIX}suggested-status:Review`);
      suggested = 'Review';
    } else if (empClass === 'permanent_ft') {
      tags.push(`${HK_TAG_PREFIX}employment:permanent-ft`);
    } else {
      tags.push(`${HK_TAG_PREFIX}employment:unknown`);
    }
    job.hkEmploymentReason = reason;
  }

  const agency = evaluateAgencyGate(job, agencyFilter);
  job.hkAgencyChannel = agency.channel;
  if (agency.demote) {
    tags.push(`${HK_TAG_PREFIX}agency:demote`);
    tags.push(`${HK_TAG_PREFIX}suggested-status:Review`);
    suggested = 'Review';
  } else if (agency.channel !== 'in-house') {
    tags.push(`${HK_TAG_PREFIX}agency:${agency.channel}`);
    if (agency.aiSignal) tags.push(`${HK_TAG_PREFIX}agency:ai-signal`);
  }

  const rankTag = formatSalaryRankTag(salaryFilter, job.salary);
  if (rankTag) tags.push(rankTag);

  if (tags.length) {
    job.note = mergeHkTags(typeof job.note === 'string' ? job.note : '', tags);
  }
  if (suggested) job.hkSuggestedStatus = suggested;
}

/**
 * Eval / merge path: upgrade Evaluated → Review when hk tags require it.
 *
 * @param {{ status?: string, notes?: string, company?: string, role?: string, title?: string }} row
 * @param {object} [portalsConfig]
 * @returns {{ status: string, notes: string, adjusted: boolean }}
 */
export function applyHkEvalStatusFromRow(row, portalsConfig = {}) {
  const status = String(row.status ?? '').trim() || 'Evaluated';
  let notes = String(row.notes ?? row.note ?? '').trim();
  if (status !== 'Evaluated' && status !== 'Shortlisted') {
    return { status, notes, adjusted: false };
  }

  const needsReview =
    /\bhk-suggested-status:Review\b/i.test(notes)
    || /\bhk-employment:contract-temp\b/i.test(notes)
    || (/\bhk-agency:demote\b/i.test(notes)
      && portalsConfig.agency_filter?.enabled !== false);

  if (!needsReview) {
    return { status, notes, adjusted: false };
  }

  if (!/\bhk-suggested-status:Review\b/i.test(notes)) {
    notes = mergeHkTags(notes, [`${HK_TAG_PREFIX}suggested-status:Review`]);
  }
  return { status: 'Review', notes, adjusted: true };
}
