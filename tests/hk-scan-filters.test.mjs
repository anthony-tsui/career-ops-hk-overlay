// tests/hk-scan-filters.test.mjs — HK Slice D employment/agency gates
import { pass, fail } from './helpers.mjs';
import {
  classifyEmployment,
  classifyWorkTypeLabel,
  companyMatchesBrandAlias,
  decorateHkScanJob,
  evaluateAgencyGate,
  applyHkEvalStatusFromRow,
  formatSalaryRankTag,
  hkFiltersActive,
} from '../lib/hk-scan-filters.mjs';
import { suggestEvalStatus } from '../hk-eval-gate.mjs';

console.log('\nHK Slice D — hk-scan-filters');

const portalsSeed = {
  employment_filter: { enabled: true },
  agency_filter: { enabled: true, demote_unless_ai: true },
  salary_filter: { min: 480000, target: 600000, currency: 'HKD' },
};

if (classifyWorkTypeLabel('Full time') === 'permanent_ft') {
  pass('workType Full time → permanent_ft');
} else fail('workType Full time classification');

if (classifyWorkTypeLabel('Contract') === 'contract_temp') {
  pass('workType Contract → contract_temp');
} else fail('workType Contract classification');

const contractJob = { title: 'Data Lead', workType: ['Contract'], company: 'HSBC' };
const emp = classifyEmployment(contractJob, portalsSeed.employment_filter);
if (emp.class === 'contract_temp') pass('classifyEmployment respects workType');
else fail(`contract employment: ${JSON.stringify(emp)}`);

/** @type {Record<string, unknown>} */
const scanJob = { title: 'Analyst', workType: ['Contract'], company: 'HSBC', url: 'https://x.test/1' };
decorateHkScanJob(scanJob, portalsSeed);
if (scanJob.hkSuggestedStatus === 'Review' && String(scanJob.note).includes('hk-employment:contract-temp')) {
  pass('decorateHkScanJob tags contract → Review (no drop flag)');
} else fail(`decorate contract: ${JSON.stringify(scanJob)}`);

const agencyJob = { title: 'Marketing Manager', company: 'Hays Hong Kong', description: 'Manage campaigns.' };
const ag = evaluateAgencyGate(agencyJob, portalsSeed.agency_filter);
if (ag.demote && ag.channel === 'agency') pass('agency demote without AI signal');
else fail(`agency demote: ${JSON.stringify(ag)}`);

const agencyAi = {
  title: 'AI Transformation Lead',
  company: 'Hays',
  description: 'Drive GenAI transformation for banking clients.',
};
const ag2 = evaluateAgencyGate(agencyAi, portalsSeed.agency_filter);
if (!ag2.demote && ag2.aiSignal) pass('agency passes with AI signal');
else fail(`agency AI pass: ${JSON.stringify(ag2)}`);

const big4 = { title: 'Audit Manager', company: 'Deloitte', description: 'External audit.' };
const b4 = evaluateAgencyGate(big4, portalsSeed.agency_filter);
if (b4.demote && b4.channel === 'big4') pass('Big4 demote without AI signal (Deloitte)');
else fail(`big4 demote: ${JSON.stringify(b4)}`);

// Big4 matcher matrix (Lima r1): no bare "ey" substring on unrelated employers.
const noAi = { title: 'Platform Engineer', description: 'Build internal tools.' };
const falsePositiveCompanies = [
  'Honeywell',
  'Key Bank HK',
  'SurveyMonkey',
  'MoneyHero',
];
for (const company of falsePositiveCompanies) {
  const r = evaluateAgencyGate({ ...noAi, company }, portalsSeed.agency_filter);
  if (r.channel === 'big4' || r.demote) {
    fail(`Big4 false positive: ${company} → ${JSON.stringify(r)}`);
  } else {
    pass(`${company} is not Big4-demoted`);
  }
}

const ernst = evaluateAgencyGate(
  { title: 'Risk Manager', company: 'Ernst & Young', description: 'Advisory.' },
  portalsSeed.agency_filter,
);
if (ernst.channel === 'big4' && ernst.demote) pass('Ernst & Young demotes without AI signal');
else fail(`Ernst & Young demote: ${JSON.stringify(ernst)}`);

const eyStandalone = evaluateAgencyGate(
  { title: 'Consultant', company: 'EY', description: 'General consulting.' },
  portalsSeed.agency_filter,
);
if (eyStandalone.channel === 'big4' && eyStandalone.demote) pass('EY (token) demotes without AI signal');
else fail(`EY token demote: ${JSON.stringify(eyStandalone)}`);

if (!companyMatchesBrandAlias('honeywell', 'ey')) pass('companyMatchesBrandAlias: honeywell ≠ ey token');
else fail('companyMatchesBrandAlias should not match ey inside honeywell');

if (companyMatchesBrandAlias('ernst young', 'Ernst & Young')) pass('companyMatchesBrandAlias: Ernst & Young phrase');
else fail('Ernst & Young phrase match');

const rankAt = formatSalaryRankTag(portalsSeed.salary_filter, { min: 610000, max: 700000, currency: 'HKD' });
if (rankAt === 'hk-salary-rank:at-target') pass('salary rank at-target');
else fail(`salary rank: ${rankAt}`);

const merge = applyHkEvalStatusFromRow(
  { status: 'Evaluated', notes: 'hk-agency:demote; hk-suggested-status:Review' },
  portalsSeed,
);
if (merge.status === 'Review') pass('merge path → Review from hk tags');
else fail(`merge status: ${merge.status}`);

const evalOut = suggestEvalStatus(
  { title: 'Contract Data Engineer', company: 'BOCHK', workType: 'Contract' },
  portalsSeed,
);
if (evalOut.suggestedStatus === 'Review') pass('hk-eval-gate suggests Review for contract');
else fail(`eval gate: ${JSON.stringify(evalOut)}`);

if (hkFiltersActive(portalsSeed) && !hkFiltersActive({})) pass('hkFiltersActive detects seed config');
else fail('hkFiltersActive');

console.log('HK Slice D tests done.');
