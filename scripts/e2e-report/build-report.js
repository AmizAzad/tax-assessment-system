#!/usr/bin/env node
'use strict';

/**
 * Renders the documented end-to-end run into a single PDF.
 *
 * The run leaves behind `docs/e2e-evidence/steps.json` plus its screenshots
 * (`apps/web/e2e/support/evidence.ts` writes both). This script turns that
 * evidence into the document a tax authority reads, so the document cannot
 * describe a run that did not happen.
 *
 * Chromium renders the PDF rather than a PDF library, because Playwright is
 * already a devDependency and a PDF toolkit would be a new one for a single
 * artifact. Screenshots are inlined as data URIs rather than referenced from
 * the temporary HTML, so the render does not depend on where that HTML sits.
 *
 * The coverage matrix lists all 44 transitions of the case state machine and
 * marks the ones no step drove. A matrix that only listed what passed would
 * be the one thing a reviewer cannot check.
 *
 *   node scripts/e2e-report/build-report.js [--input <dir>] [--out <path>]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const CONTRACTS = path.join(ROOT, 'packages', 'contracts', 'dist', 'src', 'index.js');

const DEFAULT_INPUT = path.join('docs', 'e2e-evidence');
const DEFAULT_OUT = 'tax_assessment_system_workflow.pdf';

/**
 * A screenshot is drawn at the page width, so a tall one is scaled down until
 * it fits `SHOT_MAX_HEIGHT_MM`. Full-page captures of long screens fall so far
 * below their natural size that their 14px interface text prints under a
 * millimetre tall, and a page nobody can read is a failed page. Below
 * `MIN_SHOT_SCALE` a capture is sliced into stacked panels instead of shrunk.
 * 0.8 is a judgement call: the tallest capture this run kept whole renders at
 * 0.81, and the shortest it slices at 0.77.
 */
const PAGE_CONTENT_WIDTH_MM = 186; // A4 width less the side margins `renderPdf` sets.
const SHOT_MAX_HEIGHT_MM = 230;
const MIN_SHOT_SCALE = 0.8;

/**
 * How much of the capture consecutive panels repeat. At page width 12mm is 83
 * source pixels, four lines of interface text, so a line one panel cuts is
 * readable whole in the next.
 */
const PANEL_OVERLAP_MM = 12;

const ENVIRONMENT = [
  ['API', 'http://localhost:3000'],
  ['Web', 'http://localhost:4200'],
  ['Keycloak', 'http://localhost:8085'],
  ['Postgres', 'localhost:5433'],
  ['Workflow engine', 'http://localhost:8080 (Flowable)'],
  ['Containers', 'podman'],
];

class BuildError extends Error {}

function parseArgs(argv) {
  const options = { input: DEFAULT_INPUT, out: DEFAULT_OUT };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];

    if (flag === '--input' || flag === '--out') {
      if (!value || value.startsWith('--')) {
        throw new BuildError(`${flag} needs a value.`);
      }
      options[flag === '--input' ? 'input' : 'out'] = value;
      i += 1;
    } else {
      throw new BuildError(
        `Unknown argument "${flag}". Usage: node scripts/e2e-report/build-report.js ` +
          `[--input <dir>] [--out <path>]`,
      );
    }
  }

  return {
    inputDir: path.resolve(process.cwd(), options.input),
    outFile: path.resolve(process.cwd(), options.out),
  };
}

function loadSteps(inputDir) {
  const stepsFile = path.join(inputDir, 'steps.json');

  if (!fs.existsSync(stepsFile)) {
    throw new BuildError(
      `No run evidence at ${stepsFile}.\n` +
        `Produce it with \`npm run e2e:cycle\`, which drives the documented run and writes ` +
        `steps.json plus its screenshots.\n` +
        `To report on evidence held elsewhere, pass --input <dir>.`,
    );
  }

  let steps;
  try {
    steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));
  } catch (error) {
    throw new BuildError(`${stepsFile} is not valid JSON: ${error.message}`);
  }

  if (!Array.isArray(steps) || steps.length === 0) {
    throw new BuildError(`${stepsFile} holds no steps. Re-run \`npm run e2e:cycle\`.`);
  }

  return steps;
}

function loadTransitions() {
  if (!fs.existsSync(CONTRACTS)) {
    throw new BuildError(
      `The case state machine is not built: ${CONTRACTS} is missing.\n` +
        `Build it with \`npm run build --workspace @tas/contracts\`.`,
    );
  }

  const { CASE_TRANSITIONS } = require(CONTRACTS);
  if (!Array.isArray(CASE_TRANSITIONS)) {
    throw new BuildError(`${CONTRACTS} does not export CASE_TRANSITIONS as an array.`);
  }

  return CASE_TRANSITIONS;
}

/** A case is created from nothing, so `from` is genuinely absent for INITIATE. */
const ABSENT_STATES = new Set(['', '-', '—', 'null', 'none', '(none)', 'NONE']);

function normaliseState(raw) {
  const trimmed = String(raw ?? '').trim();
  return ABSENT_STATES.has(trimmed) ? null : trimmed;
}

function transitionKey(from, action, to) {
  return `${normaliseState(from) ?? '∅'}|${String(action).trim()}|${normaliseState(to) ?? ''}`;
}

const TRANSITION_PATTERN = /^\s*(.*?)\s*--\s*([^\s-]+)\s*-->\s*(.+?)\s*$/;

function parseStepTransition(text) {
  const match = TRANSITION_PATTERN.exec(String(text ?? ''));
  return match ? { from: match[1], action: match[2], to: match[3] } : null;
}

/**
 * Which of the 44 declared transitions the run actually drove, and which step
 * numbers drove each. Steps naming a transition the machine does not declare
 * are surfaced too: that is a bug in the run, not something to swallow.
 */
function buildCoverage(steps, declared) {
  const bySteps = new Map();
  const unparsed = [];

  for (const step of steps) {
    if (!step.transition) continue;

    const parsed = parseStepTransition(step.transition);
    if (!parsed) {
      unparsed.push({ n: step.n, transition: step.transition });
      continue;
    }

    const key = transitionKey(parsed.from, parsed.action, parsed.to);
    const seen = bySteps.get(key) ?? [];
    seen.push(step.n);
    bySteps.set(key, seen);
  }

  const rows = declared.map((transition) => {
    const key = transitionKey(transition.from, transition.action, transition.to);
    return { transition, steps: bySteps.get(key) ?? [] };
  });

  const declaredKeys = new Set(declared.map((t) => transitionKey(t.from, t.action, t.to)));
  const undeclared = [...bySteps.entries()]
    .filter(([key]) => !declaredKeys.has(key))
    .map(([key, ns]) => ({ key, steps: ns }));

  const covered = rows.filter((row) => row.steps.length > 0).length;

  return {
    rows,
    undeclared,
    unparsed,
    covered,
    notCovered: rows.length - covered,
    total: rows.length,
    percentage: rows.length === 0 ? 0 : (covered / rows.length) * 100,
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value ?? 'unknown') : date.toISOString();
}

/** A PNG carries its size in the IHDR chunk, as two big-endian uint32. */
function readPngSize(buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 12, 16) !== 'IHDR') return null;

  const width = buffer.readUInt32BE(16);
  return width === 0 ? null : { width, height: buffer.readUInt32BE(20) };
}

/**
 * Stacked windows onto one image, each drawn at the page width so its text is
 * the size it is in every other screenshot, and each reading on from the one
 * above. `background-size: 100%` fixes the scale, `aspect-ratio` sets how much
 * of the image a window shows, and a percentage `background-position` slides
 * the window down in even steps, 0% at the top of the image and 100% at its
 * bottom. Only a capture past the threshold gets here, which is more than one
 * panel's worth, so there are always at least two steps to slide between.
 */
function renderPanels(source, heightMm) {
  const count = Math.ceil((heightMm - PANEL_OVERLAP_MM) / (SHOT_MAX_HEIGHT_MM - PANEL_OVERLAP_MM));
  const panelMm = (heightMm + (count - 1) * PANEL_OVERLAP_MM) / count;

  return Array.from({ length: count }, (_, index) => {
    const style =
      `aspect-ratio: ${PAGE_CONTENT_WIDTH_MM} / ${panelMm.toFixed(3)};` +
      `background-image: url(${source});` +
      `background-position: 0 ${((index / (count - 1)) * 100).toFixed(4)}%`;

    return `
      <figure class="panel">
        <figcaption>
          Part ${index + 1} of ${count} of one tall screenshot, shown at full size rather than
          shrunk to a single page. Consecutive parts overlap by ${PANEL_OVERLAP_MM}mm, so nothing
          falls between them.
        </figcaption>
        <div class="window" style="${style}"></div>
      </figure>`;
  }).join('');
}

/**
 * A missing screenshot becomes a visible note rather than a thrown error: the
 * rest of the run is still evidence, and a gap a reader can see beats a
 * document that could not be produced at all.
 */
function embedScreenshot(inputDir, relative) {
  if (!relative) return { html: '<p class="missing">No screenshot recorded for this step.</p>' };

  const absolute = path.resolve(inputDir, relative);
  if (!fs.existsSync(absolute)) {
    return {
      html: `<p class="missing">Screenshot missing from the evidence directory: ${escapeHtml(
        relative,
      )}</p>`,
    };
  }

  const buffer = fs.readFileSync(absolute);
  const source = `data:image/png;base64,${buffer.toString('base64')}`;
  const size = readPngSize(buffer);
  const heightMm = size ? (PAGE_CONTENT_WIDTH_MM * size.height) / size.width : 0;

  if (heightMm > SHOT_MAX_HEIGHT_MM / MIN_SHOT_SCALE) {
    return { html: renderPanels(source, heightMm), sliced: true };
  }

  return { html: `<img class="shot" src="${source}" alt="${escapeHtml(relative)}" />` };
}

function renderTitlePage(steps, generatedAt) {
  const timestamps = steps
    .map((step) => step.at)
    .filter(Boolean)
    .sort();
  const environment = ENVIRONMENT.map(
    ([name, value]) => `<tr><th>${escapeHtml(name)}</th><td>${escapeHtml(value)}</td></tr>`,
  ).join('');

  return `
    <section class="title-page">
      <h1>Tax Assessment System</h1>
      <h2>End-to-End Workflow</h2>
      <p class="subtitle">Evidence of a complete case lifecycle, captured from a live run.</p>
      <table class="facts">
        <tr><th>Generated</th><td>${escapeHtml(generatedAt)}</td></tr>
        <tr><th>Run started</th><td>${escapeHtml(formatTimestamp(timestamps[0]))}</td></tr>
        <tr><th>Run ended</th><td>${escapeHtml(
          formatTimestamp(timestamps[timestamps.length - 1]),
        )}</td></tr>
        <tr><th>Steps recorded</th><td>${steps.length}</td></tr>
      </table>
      <h3>Environment under test</h3>
      <table class="facts">${environment}</table>
    </section>`;
}

function renderContents(steps) {
  const items = steps
    .map(
      (step) =>
        `<li><span class="n">Step ${escapeHtml(step.n)}</span>${escapeHtml(step.title)}</li>`,
    )
    .join('');

  return `
    <section class="contents">
      <h2>Contents</h2>
      <ol class="toc">${items}</ol>
    </section>`;
}

function renderCoverage(coverage) {
  const rows = coverage.rows
    .map(({ transition, steps }) => {
      const covered = steps.length > 0;
      const label = covered
        ? `Covered by step ${steps.join(', ')}`
        : '<strong>Not covered by this run</strong>';
      return `
        <tr class="${covered ? 'covered' : 'uncovered'}">
          <td>${escapeHtml(transition.from ?? '(case creation)')}</td>
          <td class="action">${escapeHtml(transition.action)}</td>
          <td>${escapeHtml(transition.to)}</td>
          <td>${escapeHtml((transition.actors ?? []).join(', '))}</td>
          <td>${label}</td>
        </tr>`;
    })
    .join('');

  const anomalies = [];
  if (coverage.undeclared.length > 0) {
    anomalies.push(
      `<p class="anomaly">Steps naming a transition the state machine does not declare: ${escapeHtml(
        coverage.undeclared.map((u) => `${u.key} (step ${u.steps.join(', ')})`).join('; '),
      )}</p>`,
    );
  }
  if (coverage.unparsed.length > 0) {
    anomalies.push(
      `<p class="anomaly">Steps whose transition field could not be read: ${escapeHtml(
        coverage.unparsed.map((u) => `step ${u.n} (${u.transition})`).join('; '),
      )}</p>`,
    );
  }

  return `
    <section class="coverage">
      <h2>Coverage of the case state machine</h2>
      <p>
        The case lifecycle declares ${coverage.total} transitions. A transition counts as covered
        when a step in this run drove exactly that move.
      </p>
      <table class="matrix">
        <thead>
          <tr><th>From</th><th>Action</th><th>To</th><th>Actors</th><th>Covered</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="counts">
        Covered ${coverage.covered} of ${coverage.total}.
        Not covered ${coverage.notCovered}.
        Coverage ${coverage.percentage.toFixed(1)}%.
      </p>
      ${anomalies.join('')}
    </section>`;
}

function renderStep(step, inputDir) {
  const meta = [
    ['Actor', step.actor],
    ['Kind', step.kind],
    ['Transition', step.transition ?? 'none (no lifecycle move)'],
    ['Status after', step.statusAfter ?? 'unchanged'],
    ['Recorded at', formatTimestamp(step.at)],
  ]
    .map(([name, value]) => `<span><b>${escapeHtml(name)}:</b> ${escapeHtml(value)}</span>`)
    .join('<span class="sep">|</span>');

  const shot = embedScreenshot(inputDir, step.screenshot);

  return `
    <section class="step${shot.sliced ? ' sliced' : ''}">
      <h2>Step ${escapeHtml(step.n)}. ${escapeHtml(step.title)}</h2>
      <p class="meta">${meta}</p>
      <p class="description">${escapeHtml(step.description)}</p>
      <p class="proves"><b>What this proves.</b> ${escapeHtml(step.expected)}</p>
      ${shot.html}
    </section>`;
}

function renderAppendix(steps) {
  const rows = steps
    .map(
      (step) => `
        <tr>
          <td>${escapeHtml(step.n)}</td>
          <td class="action">${escapeHtml(step.id)}</td>
          <td>${escapeHtml(step.actor)}</td>
          <td>${escapeHtml(step.transition ?? '-')}</td>
          <td>${escapeHtml(formatTimestamp(step.at))}</td>
        </tr>`,
    )
    .join('');

  return `
    <section class="appendix">
      <h2>Appendix A. Raw step record</h2>
      <p>Every row below is taken verbatim from the evidence file the run wrote.</p>
      <table class="matrix">
        <thead>
          <tr><th>#</th><th>Step id</th><th>Actor</th><th>Transition</th><th>Timestamp</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

const STYLES = `
  @page { size: A4; }
  * { box-sizing: border-box; }
  body {
    background: #ffffff;
    color: #111111;
    font-family: "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 10.5pt;
    line-height: 1.45;
    margin: 0;
  }
  h1 { font-size: 26pt; margin: 0 0 4pt; }
  h2 { font-size: 14pt; margin: 0 0 6pt; }
  h3 { font-size: 11pt; margin: 18pt 0 6pt; }
  p { margin: 0 0 8pt; }
  section { break-inside: avoid; margin-bottom: 18pt; }
  .page-break { break-after: page; }
  .title-page { padding-top: 40mm; }
  .title-page h2 { font-size: 18pt; font-weight: 400; margin-bottom: 14pt; }
  .subtitle { font-size: 11pt; margin-bottom: 18pt; }
  table { border-collapse: collapse; width: 100%; }
  .facts { width: 100%; max-width: 120mm; margin-bottom: 8pt; }
  .facts th, .facts td { border: 1px solid #cccccc; padding: 4pt 6pt; text-align: left; }
  .facts th { width: 40mm; background: #f2f2f2; font-weight: 600; }
  .matrix { font-size: 8.5pt; }
  .matrix th, .matrix td {
    border: 1px solid #cccccc;
    padding: 3pt 5pt;
    text-align: left;
    vertical-align: top;
  }
  .matrix thead th { background: #e8e8e8; }
  .matrix thead { display: table-header-group; }
  .matrix tr { break-inside: avoid; }
  .action { font-family: "Consolas", "Courier New", monospace; }
  tr.uncovered td { background: #fbeaea; }
  .counts { margin-top: 8pt; font-weight: 600; }
  .anomaly { font-size: 9pt; color: #7a1f1f; }
  .toc { column-count: 2; column-gap: 12mm; font-size: 9.5pt; list-style: none; padding: 0; }
  .toc li { break-inside: avoid; margin-bottom: 3pt; }
  .toc .n { display: inline-block; min-width: 18mm; font-weight: 600; }
  .step .meta { font-size: 9pt; color: #333333; }
  .step .meta .sep { padding: 0 5pt; color: #999999; }
  .proves { border-left: 3px solid #333333; padding-left: 8pt; }
  .missing { color: #7a1f1f; font-style: italic; }
  .shot {
    display: block;
    width: 100%;
    max-height: ${SHOT_MAX_HEIGHT_MM}mm;
    object-fit: contain;
    object-position: top left;
    border: 1px solid #999999;
  }
  .step.sliced { break-inside: auto; }
  .panel { break-inside: avoid; margin: 0 0 8pt; }
  .panel figcaption { font-size: 8.5pt; color: #444444; margin-bottom: 3pt; }
  .panel .window {
    width: 100%;
    border: 1px solid #999999;
    background-repeat: no-repeat;
    background-size: 100% auto;
    background-origin: border-box;
  }
`;

function renderDocument({ steps, coverage, inputDir, generatedAt }) {
  const stepSections = steps.map((step) => renderStep(step, inputDir)).join('\n');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Tax Assessment System - End-to-End Workflow</title>
    <style>${STYLES}</style>
  </head>
  <body>
    ${renderTitlePage(steps, generatedAt)}
    <div class="page-break"></div>
    ${renderContents(steps)}
    <div class="page-break"></div>
    ${renderCoverage(coverage)}
    <div class="page-break"></div>
    ${stepSections}
    <div class="page-break"></div>
    ${renderAppendix(steps)}
  </body>
</html>`;
}

async function renderPdf(html, outFile) {
  const { chromium } = require('@playwright/test');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tas-workflow-report-'));
  const htmlFile = path.join(tempDir, 'report.html');
  fs.writeFileSync(htmlFile, html, 'utf8');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`file://${htmlFile.split(path.sep).join('/')}`, { waitUntil: 'load' });
    await page.pdf({
      path: outFile,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate:
        '<div style="width:100%;font-size:7pt;color:#666;padding:0 12mm;">' +
        'Tax Assessment System &mdash; End-to-End Workflow</div>',
      footerTemplate:
        '<div style="width:100%;font-size:7pt;color:#666;padding:0 12mm;text-align:right;">' +
        'Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
      margin: { top: '16mm', bottom: '16mm', left: '12mm', right: '12mm' },
    });
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const { inputDir, outFile } = parseArgs(process.argv.slice(2));
  const steps = loadSteps(inputDir);
  const coverage = buildCoverage(steps, loadTransitions());
  const html = renderDocument({
    steps,
    coverage,
    inputDir,
    generatedAt: new Date().toISOString(),
  });

  await renderPdf(html, outFile);

  const { size } = fs.statSync(outFile);
  process.stdout.write(
    `${outFile}\n` +
      `  ${steps.length} steps, ${Math.round(size / 1024)} KB\n` +
      `  transitions covered ${coverage.covered}/${coverage.total} ` +
      `(${coverage.percentage.toFixed(1)}%), not covered ${coverage.notCovered}\n`,
  );
}

main().catch((error) => {
  if (error instanceof BuildError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`Failed to build the workflow PDF.\n${error.stack ?? error}\n`);
  }
  process.exitCode = 1;
});
