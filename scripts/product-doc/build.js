// Builds the leadership document from the live case state machine.
//
// The transition table is read from @tas/contracts, the definition the
// platform enforces, so a lifecycle change shows up here the next time the
// document is built. The flow diagrams are laid out by hand for legibility;
// a transition added to the contracts must be drawn into flow.js as well.
//
// usage: npm run docs:product
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('@playwright/test');

const here = __dirname;
const root = path.join(here, '..', '..');
const outPdf = path.join(root, 'docs', 'product', 'Tax-Assessment-Platform-Overview.pdf');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'product-doc-'));
const templatePath = path.join(here, 'template.html');

require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
const contracts = require(path.join(root, 'packages', 'contracts', 'src'));
const sm = {
  statuses: Object.values(contracts.CaseStatus),
  terminal: contracts.TERMINAL_CASE_STATUSES,
  transitions: contracts.CASE_TRANSITIONS,
};
execFileSync(process.execPath, [path.join(here, 'flow.js'), work], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(here, 'arch.js'), work], { stdio: 'inherit' });
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const NAME = {
  INITIATED: 'Initiated',
  DATA_READY: 'Data ready',
  ASSIGNED: 'Assigned',
  IN_PREPARATION: 'In preparation',
  AWAITING_TAXPAYER: 'Awaiting taxpayer (information)',
  CALCULATED: 'Calculated',
  UNDER_REVIEW: 'Under review',
  REVIEW_RETURNED: 'Returned for rework',
  REVIEWED: 'Reviewed',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected by approver',
  FINALISED: 'Finalised',
  NOTICE_GENERATED: 'Notice generated',
  NOTICE_SERVED: 'Notice served',
  AWAITING_TAXPAYER_RESPONSE: 'Response window open',
  SETTLED: 'Settled (paid)',
  UNDER_OBJECTION: 'Under objection',
  OBJECTION_ALLOWED: 'Objection allowed',
  OBJECTION_PARTLY_ALLOWED: 'Objection partly allowed',
  OBJECTION_REJECTED: 'Objection rejected',
  UNDER_APPEAL: 'Under appeal',
  APPEAL_UPHELD: 'Appeal: assessment upheld',
  APPEAL_VARIED: 'Appeal: assessment varied',
  APPEAL_SET_ASIDE: 'Appeal: set aside',
  APPEAL_REMANDED: 'Appeal: remanded',
  REASSESSMENT_INITIATED: 'Reassessment opened',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
  TIME_BARRED: 'Time-barred',
  WRITTEN_OFF: 'Written off',
  FINALISATION_FAILED: 'Finalisation failed',
  NOTICE_FAILED: 'Notice failed',
};
const ACTION = {
  INITIATE: 'Open the case',
  RETRIEVE_DATA: 'Evidence retrieved from every mandatory source',
  CANCEL: 'Cancel the case',
  ASSIGN: 'Assign to a named assessor',
  START: 'Start or resume preparation',
  REQUEST_INFO: 'Request information from the taxpayer',
  RESPOND: 'Record the taxpayer’s response',
  TIMEOUT: 'No reply by the due date',
  CALCULATE: 'Calculate the liability',
  SUBMIT: 'Submit for review',
  RETURN: 'Return for rework',
  ACCEPT: 'Accept the prepared assessment',
  ROUTE_APPROVAL: 'Route to the approver band for the amount',
  APPROVE: 'Approve',
  REJECT: 'Reject',
  FINALISE: 'Finalise: the figure becomes the determination',
  GENERATE_NOTICE: 'Generate the assessment notice',
  SERVED: 'Serve the notice',
  START_RESPONSE_WINDOW: 'Open the taxpayer’s response window',
  PAYMENT_SETTLED: 'Paid in full (derived from the account)',
  FILE_OBJECTION: 'File an objection',
  WINDOW_LAPSED: 'Response window lapses with no objection',
  DECIDE_ALLOWED: 'Allow the objection',
  DECIDE_PARTLY_ALLOWED: 'Partly allow the objection',
  DECIDE_REJECTED: 'Reject the objection',
  REASSESS: 'Reassess in place',
  FILE_APPEAL: 'File an appeal',
  CLOSE: 'Close the case',
  RECORD_UPHELD: 'Record: forum upheld the assessment',
  RECORD_VARIED: 'Record: forum varied the assessment',
  RECORD_SET_ASIDE: 'Record: forum set the assessment aside',
  RECORD_REMANDED: 'Record: forum remanded the case',
  LIMITATION_EXPIRED: 'Limitation date passes',
  WRITE_OFF: 'Write off the liability',
};
const ROLE = {
  TA_SUPERVISOR: 'Supervisor',
  SYSTEM: 'System',
  TA_ADMIN: 'Administrator',
  TA_ASSESSOR: 'Assessor',
  TA_TAXPAYER: 'Taxpayer',
  TA_REVIEWER: 'Reviewer',
  TA_APPROVER_L1: 'Approver L1',
  TA_APPROVER_L2: 'Approver L2',
  TA_APPROVER_L3: 'Approver L3',
  TA_NOTICE_ISSUER: 'Notice issuer',
  TA_OBJECTION_OFFICER: 'Objection officer',
  TA_APPEALS_OFFICER: 'Appeals officer',
};

let n = 0;
const rows = sm.transitions.map((t) => {
  n += 1;
  return `<tr><td class="num">${n}</td><td>${esc(t.from ? NAME[t.from] : '— (start)')}</td><td>${esc(ACTION[t.action] ?? t.action)}</td><td>${esc(NAME[t.to])}</td><td>${esc(t.actors.map((a) => ROLE[a] ?? a).join(', '))}</td><td class="c">${t.requiresReason ? 'Yes' : ''}</td></tr>`;
});
for (const from of ['CLOSED', 'SETTLED', 'WRITTEN_OFF']) {
  n += 1;
  rows.push(
    `<tr class="succ"><td class="num">${n}</td><td>${esc(NAME[from])}</td><td>Reassess on new information: a successor case is opened</td><td>Initiated (new case)</td><td>Supervisor</td><td class="c">Yes</td></tr>`,
  );
}

let html = fs.readFileSync(templatePath, 'utf8');
const svg = (f) =>
  fs
    .readFileSync(path.join(work, f), 'utf8')
    .replace(/ width="[\d.]+" height="[\d.]+"/, ' width="100%"');
html = html
  .replace('{{TRANSITIONS}}', rows.join('\n'))
  .replace('{{TRANSITION_COUNT}}', String(sm.transitions.length))
  .replace('{{STATUS_COUNT}}', String(sm.statuses.length))
  .replace('{{FLOW_OVERVIEW}}', svg('flow-overview.svg'))
  .replace('{{FLOW_PART1}}', svg('flow-part1.svg'))
  .replace('{{FLOW_PART2}}', svg('flow-part2.svg'))
  .replace('{{ARCHITECTURE}}', svg('architecture.svg'));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({
    path: outPdf,
    preferCSSPageSize: true,
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate:
      '<div style="width:100%;font:8px Segoe UI,Arial,sans-serif;color:#6b7280;padding:0 14mm;display:flex;justify-content:space-between">' +
      '<span>Tax Assessment Platform — Product Overview, Status and Roadmap · v1.0 · 30 September 2026</span>' +
      '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>',
    margin: { top: '14mm', bottom: '16mm', left: '14mm', right: '14mm' },
  });
  await browser.close();
  console.log('wrote', outPdf);
})();
