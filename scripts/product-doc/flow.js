// Hand-laid case lifecycle diagrams for the leadership document.
// usage: node flow.js <outDir>
const fs = require('fs');
const path = require('path');
const outDir = process.argv[2] ?? 'out';
fs.mkdirSync(outDir, { recursive: true });

const W = 190;
const H = 42;
const STAGE_COLOURS = {
  open: ['#e8f1fb', '#2f6db3'],
  prep: ['#eaf6ee', '#2e8b57'],
  decide: ['#fff4e0', '#b86e00'],
  serve: ['#efeafb', '#6a4bb3'],
  dispute: ['#fde9ea', '#b3343f'],
  appeal: ['#fce8f3', '#a3336f'],
  end: ['#eceff3', '#3f4957'],
  tab: ['#1f3a5f', '#1f3a5f'],
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function canvas(width, height) {
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Segoe UI, Arial, sans-serif">`,
    '<defs>',
    '<marker id="ah" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#4b5563"/></marker>',
    '<marker id="ahd" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#8a6d3b"/></marker>',
    '</defs>',
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
  );
  const nodes = {};
  const api = {
    node(id, x, y, label, stage, opts = {}) {
      nodes[id] = { x, y };
      const [fill, stroke] = STAGE_COLOURS[stage];
      const w = opts.w ?? W;
      const end = opts.final;
      parts.push(
        `<rect x="${x - w / 2}" y="${y - H / 2}" width="${w}" height="${H}" rx="11" fill="${fill}" stroke="${stroke}" stroke-width="${end ? 3.2 : 1.7}"/>`,
        `<text x="${x}" y="${y + 5}" font-size="14" font-weight="600" text-anchor="middle" fill="${stage === 'tab' ? '#fff' : '#111827'}">${esc(label)}</text>`,
      );
      if (opts.successor) {
        parts.push(
          `<text x="${x + w / 2 - 6}" y="${y - H / 2 + 13}" font-size="12" text-anchor="end" fill="#8a6d3b">↺</text>`,
        );
      }
    },
    start(x, y) {
      parts.push(`<circle cx="${x}" cy="${y}" r="11" fill="#1f3a5f"/>`);
    },
    tab(x, y, lines, w = 180) {
      const h = lines.length * 16 + 12;
      parts.push(
        `<rect x="${x}" y="${y - h / 2}" width="${w}" height="${h}" rx="6" fill="#1f3a5f"/>`,
      );
      lines.forEach((l, k) => {
        parts.push(
          `<text x="${x + w / 2}" y="${y - h / 2 + 20 + k * 16}" font-size="12.5" font-weight="${k ? 400 : 600}" text-anchor="middle" fill="#ffffff">${esc(l)}</text>`,
        );
      });
    },
    edge(points, opts = {}) {
      const d = points.map((p, k) => `${k ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ');
      parts.push(`<path d="${d}" fill="none" stroke="#ffffff" stroke-width="7"/>`);
      parts.push(
        `<path d="${d}" fill="none" stroke="${opts.dashed ? '#8a6d3b' : '#4b5563'}" stroke-width="1.6" ${opts.dashed ? 'stroke-dasharray="6 4"' : ''} ${opts.noArrow ? '' : `marker-end="url(#${opts.dashed ? 'ahd' : 'ah'})"`}/>`,
      );
    },
    // action on the first line, who on the second; anchor 'start' | 'end' | 'middle'
    label(x, y, action, who, anchor = 'start') {
      const lines = [action, who ? `(${who})` : null].filter(Boolean);
      const width = Math.max(...lines.map((l, k) => l.length * (k ? 6.1 : 6.9)));
      const left =
        anchor === 'start' ? x - 2 : anchor === 'end' ? x - width - 2 : x - width / 2 - 2;
      parts.push(
        `<rect x="${left}" y="${y - 12}" width="${width + 4}" height="${lines.length * 14 + 2}" fill="#ffffff" opacity="0.92"/>`,
      );
      lines.forEach((l, k) => {
        parts.push(
          `<text x="${x}" y="${y + k * 14}" font-size="${k ? 11 : 12.5}" ${k ? 'fill="#4b5563"' : 'font-weight="600" fill="#111827"'} text-anchor="${anchor}">${esc(l)}</text>`,
        );
      });
    },
    lane(x1, x2, y, title) {
      parts.push(
        `<text x="${(x1 + x2) / 2}" y="${y}" font-size="15" font-weight="700" letter-spacing="0.08em" text-anchor="middle" fill="#6b7280">${esc(title.toUpperCase())}</text>`,
      );
    },
    raw(s) {
      parts.push(s);
    },
    done(file) {
      parts.push('</svg>');
      fs.writeFileSync(path.join(outDir, file), parts.join('\n'));
    },
  };
  return api;
}

// ------------------------------------------------------------------ Part 1
{
  const c = canvas(1460, 1010);
  const X = [170, 510, 850, 1190];
  c.lane(X[0] - 95, X[0] + 95, 26, 'Open');
  c.lane(X[1] - 95, X[1] + 95, 26, 'Prepare');
  c.lane(X[2] - 95, X[2] + 95, 26, 'Review and approve');
  c.lane(X[3] - 95, X[3] + 95, 26, 'Determine and serve');

  c.start(X[0], 62);
  c.node('INITIATED', X[0], 130, 'Initiated', 'open');
  c.node('DATA_READY', X[0], 260, 'Data ready', 'open');
  c.node('ASSIGNED', X[0], 390, 'Assigned', 'open');
  c.node('TIME_BARRED', X[0], 520, 'Time-barred', 'end', { final: true });
  c.node('CANCELLED', X[0], 650, 'Cancelled', 'end', { final: true });

  c.node('AWAITING_TAXPAYER', X[1], 260, 'Awaiting taxpayer (information)', 'prep', { w: 230 });
  c.node('IN_PREPARATION', X[1], 390, 'In preparation', 'prep');
  c.node('CALCULATED', X[1], 520, 'Calculated', 'prep');
  c.node('REVIEW_RETURNED', X[1], 650, 'Returned for rework', 'prep');
  c.node('REJECTED', X[1], 780, 'Rejected by approver', 'prep');
  c.node('REASSESSMENT_INITIATED', X[1], 910, 'Reassessment opened', 'prep');

  c.node('UNDER_REVIEW', X[2], 520, 'Under review', 'decide');
  c.node('REVIEWED', X[2], 650, 'Reviewed', 'decide');
  c.node('PENDING_APPROVAL', X[2], 780, 'Pending approval', 'decide');
  c.node('APPROVED', X[2], 910, 'Approved', 'decide');

  c.node('FINALISED', X[3], 910, 'Finalised', 'serve');
  c.node('NOTICE_GENERATED', X[3], 780, 'Notice generated', 'serve');
  c.node('NOTICE_SERVED', X[3], 650, 'Notice served', 'serve');
  c.node('AWAITING_TAXPAYER_RESPONSE', X[3], 520, 'Response window open', 'serve', { w: 200 });

  // Opening
  c.edge([
    [X[0], 73],
    [X[0], 109],
  ]);
  c.label(X[0] + 12, 88, 'Open case', 'Supervisor, System, Administrator');
  c.edge([
    [X[0], 151],
    [X[0], 239],
  ]);
  c.label(X[0] + 12, 190, 'Evidence retrieved', 'System');
  c.edge([
    [X[0], 281],
    [X[0], 369],
  ]);
  c.label(X[0] + 12, 320, 'Assign to an assessor', 'Supervisor');
  c.edge([
    [X[0] - 95, 136],
    [42, 136],
    [42, 650],
    [X[0] - 95, 650],
  ]);
  c.label(52, 612, 'Cancel *', 'Supervisor');
  c.edge([
    [X[0] - 95, 124],
    [26, 124],
    [26, 520],
    [X[0] - 95, 520],
  ]);
  c.label(52, 488, 'Limitation date passes', 'System');
  c.edge([
    [X[0] + 95, 390],
    [X[1] - 95, 390],
  ]);
  c.label(X[0] + 104, 366, 'Start preparation', 'Assessor');

  // Preparation
  c.edge([
    [X[1] - 30, 369],
    [X[1] - 30, 281],
  ]);
  c.label(X[1] - 38, 318, 'Request information', 'Assessor', 'end');
  c.edge([
    [X[1] + 30, 281],
    [X[1] + 30, 369],
  ]);
  c.label(X[1] + 42, 300, 'Response recorded', 'Taxpayer, Assessor, Supervisor');
  c.label(X[1] + 42, 334, 'or no reply by the due date', 'System');
  c.edge([
    [X[1], 411],
    [X[1], 499],
  ]);
  c.label(X[1] + 12, 450, 'Calculate', 'Assessor, System');
  c.edge([
    [X[1] - 95, 402],
    [322, 402],
    [322, 520],
    [X[0] + 95, 520],
  ]);
  c.label(316, 446, 'Limitation date passes', 'System', 'end');
  // Rework returns: one bus into preparation
  for (const y of [650, 780, 910])
    c.edge(
      [
        [X[1] - 95, y],
        [366, y],
      ],
      { noArrow: true },
    );
  c.edge([
    [366, 910],
    [366, 414],
    [X[1] - 95, 414],
  ]);
  c.label(358, 730, 'Resume preparation', 'Assessor', 'end');

  // Review and approval
  c.edge([
    [X[1] + 95, 520],
    [X[2] - 95, 520],
  ]);
  c.label(X[1] + 106, 498, 'Submit for review', 'Assessor');
  c.edge([
    [X[2], 541],
    [X[2], 629],
  ]);
  c.label(X[2] + 12, 582, 'Accept', 'Reviewer — not the assessor');
  c.edge([
    [X[2] - 60, 541],
    [X[2] - 60, 590],
    [660, 590],
    [660, 650],
    [X[1] + 95, 650],
  ]);
  c.label(666, 612, 'Return for rework *', 'Reviewer');
  c.edge([
    [X[2], 671],
    [X[2], 759],
  ]);
  c.label(X[2] + 12, 712, 'Route by amount band', 'System');
  c.edge([
    [X[2], 801],
    [X[2], 889],
  ]);
  c.label(X[2] + 12, 842, 'Approve', 'Approver of the right level');
  c.edge([
    [X[2] - 95, 780],
    [X[1] + 95, 780],
  ]);
  c.label(X[1] + 106, 758, 'Reject *', 'Approver');

  // Determination and service
  c.edge([
    [X[2] + 95, 910],
    [X[3] - 95, 910],
  ]);
  c.label(X[2] + 106, 872, 'Finalise', 'System, on approval');
  c.edge([
    [X[3], 889],
    [X[3], 801],
  ]);
  c.label(X[3] + 12, 842, 'Generate notice', 'System');
  c.edge([
    [X[3], 759],
    [X[3], 671],
  ]);
  c.label(X[3] + 12, 712, 'Serve notice', 'System, Notice issuer');
  c.edge([
    [X[3], 629],
    [X[3], 541],
  ]);
  c.label(X[3] + 12, 582, 'Response window starts', 'System');

  // Connectors to Part 2
  c.edge([
    [X[3] + 100, 520],
    [1296, 520],
  ]);
  c.tab(1300, 520, ['Continues in Part 2', 'pay, object, appeal'], 150);
  c.tab(1300, 975, ['From Part 2', 'reassess in place'], 150);
  c.edge([
    [1300, 975],
    [X[1], 975],
    [X[1], 931],
  ]);
  c.label(
    X[1] + 170,
    962,
    'Reassess in place',
    'System — after an objection is allowed or partly allowed, or an appeal is varied or remanded',
  );
  c.tab(1300, 70, ['From Part 2', 'new information'], 150);
  c.edge(
    [
      [1290, 70],
      [372, 70],
      [372, 118],
      [X[0] + 95, 118],
    ],
    { dashed: true },
  );
  c.label(
    560,
    58,
    'Successor case opened on new information',
    'Supervisor — after the case is Closed, Settled or Written off; a new case begins',
  );

  c.done('flow-part1.svg');
}

// ------------------------------------------------------------------ Part 2
{
  const c = canvas(1850, 1010);
  const X = [170, 540, 930, 1310, 1680];
  c.lane(X[0] - 100, X[0] + 100, 26, 'Response window');
  c.lane(X[1] - 95, X[1] + 95, 26, 'Taxpayer’s response');
  c.lane(X[2] - 95, X[2] + 95, 26, 'Objection decided');
  c.lane(X[3] - 95, X[3] + 95, 26, 'Appeal');
  c.lane(X[4] - 115, X[4] + 115, 26, 'Appeal outcome');

  c.tab(20, 430, ['From Part 1', 'notice served'], 130);
  c.edge([
    [85, 452],
    [85, 499],
  ]);
  c.node('AWAITING_TAXPAYER_RESPONSE', X[0], 520, 'Response window open', 'serve', { w: 200 });

  c.node('WRITTEN_OFF', X[1], 130, 'Written off', 'end', { final: true, successor: true });
  c.node('SETTLED', X[1], 260, 'Settled (paid)', 'end', { successor: true });
  c.node('UNDER_OBJECTION', X[1], 520, 'Under objection', 'dispute');

  c.node('CLOSED', X[2], 260, 'Closed', 'end', { final: true, successor: true });
  c.node('OBJECTION_REJECTED', X[2], 520, 'Objection rejected', 'dispute');
  c.node('OBJECTION_ALLOWED', X[2], 650, 'Objection allowed', 'dispute');
  c.node('OBJECTION_PARTLY_ALLOWED', X[2], 780, 'Objection partly allowed', 'dispute', { w: 210 });

  c.node('UNDER_APPEAL', X[3], 520, 'Under appeal', 'appeal');

  c.node('APPEAL_UPHELD', X[4], 260, 'Appeal: assessment upheld', 'appeal', { w: 230 });
  c.node('APPEAL_SET_ASIDE', X[4], 390, 'Appeal: set aside', 'appeal', { w: 230 });
  c.node('APPEAL_VARIED', X[4], 650, 'Appeal: assessment varied', 'appeal', { w: 230 });
  c.node('APPEAL_REMANDED', X[4], 780, 'Appeal: remanded', 'appeal', { w: 230 });

  // From the response window
  c.edge([
    [X[0] + 100, 520],
    [X[1] - 95, 520],
  ]);
  c.label(X[0] + 110, 562, 'File objection', 'Taxpayer, Objection officer, Supervisor');
  c.edge([
    [X[0] + 40, 499],
    [X[0] + 40, 260],
    [X[1] - 95, 260],
  ]);
  c.label(X[0] + 50, 238, 'Paid in full', 'System');
  c.edge([
    [X[0], 499],
    [X[0], 130],
    [X[1] - 95, 130],
  ]);
  c.label(X[0] + 10, 108, 'Write off *', 'Supervisor');
  c.edge([
    [X[0] + 100, 530],
    [300, 530],
    [300, 350],
    [X[2] - 40, 350],
    [X[2] - 40, 281],
  ]);
  c.label(470, 372, 'Response window lapses with no objection', 'System');

  // Settlement and closure
  c.edge([
    [X[1] + 95, 260],
    [X[2] - 95, 260],
  ]);
  c.label(X[1] + 104, 238, 'Close', 'Supervisor, System');

  // Objection decisions
  c.edge([
    [X[1] + 95, 520],
    [X[2] - 95, 520],
  ]);
  c.label(X[1] + 106, 506, 'Reject', null);
  c.edge([
    [X[1] + 95, 530],
    [700, 530],
    [700, 650],
    [X[2] - 95, 650],
  ]);
  c.label(710, 640, 'Allow', null);
  c.edge([
    [X[1] + 95, 538],
    [670, 538],
    [670, 780],
    [X[2] - 105, 780],
  ]);
  c.label(680, 770, 'Partly allow', null);
  c.label(
    640,
    860,
    'Decided by the Objection officer',
    'after admissibility, deposit and committee opinion',
  );
  c.edge([
    [X[2], 499],
    [X[2], 281],
  ]);
  c.label(X[2] + 10, 430, 'Close', 'System, Supervisor');

  // Appeal
  c.edge([
    [X[2] + 95, 520],
    [X[3] - 95, 520],
  ]);
  c.label(X[2] + 104, 562, 'File appeal', 'Taxpayer, Appeals officer, Supervisor');
  c.edge([
    [X[3] + 95, 505],
    [1450, 505],
    [1450, 390],
    [X[4] - 115, 390],
  ]);
  c.label(1498, 380, 'Set aside', null);
  c.edge([
    [X[3] + 95, 512],
    [1490, 512],
    [1490, 260],
    [X[4] - 115, 260],
  ]);
  c.label(1498, 250, 'Upheld', null);
  c.edge([
    [X[3] + 95, 528],
    [1490, 528],
    [1490, 650],
    [X[4] - 115, 650],
  ]);
  c.label(1498, 640, 'Varied', null);
  c.edge([
    [X[3] + 95, 535],
    [1450, 535],
    [1450, 780],
    [X[4] - 115, 780],
  ]);
  c.label(1458, 770, 'Remanded', null);
  c.label(1400, 860, 'Recorded by the Appeals officer', 'the forum outside the authority decides');

  // Appeal outcomes
  c.edge([
    [X[4] + 115, 390],
    [1810, 390],
    [1810, 200],
    [X[2] + 40, 200],
    [X[2] + 40, 239],
  ]);
  c.label(1100, 188, 'Close', 'System, Supervisor');
  c.edge([
    [X[4], 239],
    [X[4], 160],
    [X[1] + 40, 160],
    [X[1] + 40, 239],
  ]);
  c.label(900, 148, 'Paid in full', 'System');

  // Reassess in place: one bus back to Part 1
  c.edge(
    [
      [X[2] + 95, 650],
      [1060, 650],
      [1060, 960],
    ],
    { noArrow: true },
  );
  c.edge(
    [
      [X[2] + 105, 780],
      [1060, 780],
    ],
    { noArrow: true },
  );
  c.edge(
    [
      [X[4] + 115, 650],
      [1830, 650],
      [1830, 960],
    ],
    { noArrow: true },
  );
  c.edge(
    [
      [X[4] + 115, 780],
      [1830, 780],
    ],
    { noArrow: true },
  );
  c.edge([
    [1830, 960],
    [154, 960],
  ]);
  c.tab(20, 960, ['Back to Part 1', 'reassessment opened'], 130);
  c.label(
    1080,
    948,
    'Reassess in place',
    'System — the case is reworked and goes through review and approval again',
  );

  c.done('flow-part2.svg');
}

// ------------------------------------------------------------------ Overview
{
  const c = canvas(1440, 470);
  const stages = [
    [
      'Open',
      'open',
      'Case opened by a supervisor, by risk selection, or by the system; evidence gathered',
    ],
    [
      'Prepare',
      'prep',
      'Assessor adjusts the declared figures with reasons and runs the calculation',
    ],
    [
      'Review and approve',
      'decide',
      'A different officer reviews; approval is routed by amount band',
    ],
    ['Determine and serve', 'serve', 'The figure becomes final and a signed notice is served'],
    ['Respond', 'dispute', 'Taxpayer pays, objects, or lets the window lapse'],
    ['Dispute', 'appeal', 'Objection decided; appeal recorded; reassessment if required'],
    ['Close', 'end', 'Settled and closed, written off, cancelled or time-barred'],
  ];
  const bw = 190;
  const gap = 15;
  stages.forEach(([title, stage, text], k) => {
    const x = 20 + k * (bw + gap);
    const [fill, stroke] = STAGE_COLOURS[stage];
    c.raw(
      `<rect x="${x}" y="40" width="${bw}" height="170" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="1.8"/>`,
    );
    c.raw(
      `<text x="${x + 14}" y="72" font-size="14" font-weight="700" fill="${stroke}">${k + 1}. ${esc(title)}</text>`,
    );
    const words = text.split(' ');
    let line = '';
    let row = 0;
    for (const w of words) {
      if ((line + ' ' + w).trim().length > 24) {
        c.raw(
          `<text x="${x + 14}" y="${100 + row * 18}" font-size="12.5" fill="#1f2937">${esc(line.trim())}</text>`,
        );
        line = w;
        row += 1;
      } else line += ' ' + w;
    }
    c.raw(
      `<text x="${x + 14}" y="${100 + row * 18}" font-size="12.5" fill="#1f2937">${esc(line.trim())}</text>`,
    );
    if (k < stages.length - 1)
      c.edge([
        [x + bw + 2, 125],
        [x + bw + gap - 2, 125],
      ]);
  });
  // loops
  const cx = (k) => 20 + k * (bw + gap) + bw / 2;
  c.edge([
    [cx(2), 212],
    [cx(2), 260],
    [cx(1) + 30, 260],
    [cx(1) + 30, 214],
  ]);
  c.label(cx(1) + 40, 282, 'Returned or rejected: back to preparation', null);
  c.edge([
    [cx(5), 212],
    [cx(5), 330],
    [cx(1) - 30, 330],
    [cx(1) - 30, 214],
  ]);
  c.label(
    cx(2) + 60,
    352,
    'Objection allowed, appeal varied or remanded: reassess and review again',
    null,
  );
  c.edge(
    [
      [cx(6), 212],
      [cx(6), 400],
      [cx(0), 400],
      [cx(0), 214],
    ],
    { dashed: true },
  );
  c.label(cx(2) + 80, 422, 'New information after closure: a successor case is opened', null);
  c.edge([
    [cx(4) + 40, 212],
    [cx(4) + 40, 250],
    [cx(6) - 30, 250],
    [cx(6) - 30, 214],
  ]);
  c.label(cx(5) - 60, 242, 'Paid, lapsed, written off', null);
  c.done('flow-overview.svg');
}
console.log('ok');
