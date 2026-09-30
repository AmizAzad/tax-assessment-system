// Architecture-at-a-glance block diagram.
// usage: node arch.js <outDir>
const fs = require('fs');
const path = require('path');
const outDir = process.argv[2] ?? 'out';
const W = 1200;
const H = 640;
const p = [];
const esc = (s) => String(s).replace(/&/g, '&amp;');
p.push(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Segoe UI, Arial, sans-serif">`,
);
p.push(
  '<defs><marker id="a" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#4b5563"/></marker></defs>',
);
p.push(`<rect width="${W}" height="${H}" fill="#fff"/>`);
function box(x, y, w, h, title, lines, fill, stroke, dashed) {
  p.push(
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="1.8" ${dashed ? 'stroke-dasharray="6 4"' : ''}/>`,
  );
  p.push(
    `<text x="${x + 14}" y="${y + 24}" font-size="15" font-weight="700" fill="${stroke}">${esc(title)}</text>`,
  );
  lines.forEach((l, k) =>
    p.push(
      `<text x="${x + 14}" y="${y + 46 + k * 18}" font-size="12.5" fill="#1f2937">${esc(l)}</text>`,
    ),
  );
}
function arrow(pts, both, label, lx, ly) {
  p.push(
    `<path d="${pts.map((q, k) => `${k ? 'L' : 'M'}${q[0]},${q[1]}`).join(' ')}" fill="none" stroke="#4b5563" stroke-width="1.6" marker-end="url(#a)" ${both ? 'marker-start="url(#a)"' : ''}/>`,
  );
  if (label)
    p.push(`<text x="${lx}" y="${ly}" font-size="11.5" fill="#4b5563">${esc(label)}</text>`);
}
// people
box(
  20,
  20,
  260,
  90,
  'Officers',
  ['Nine officer roles in a browser', 'Keycloak sign-in'],
  '#e8f1fb',
  '#2f6db3',
);
box(
  20,
  130,
  260,
  90,
  'Taxpayers',
  ['Portal: own assessments,', 'notices, objections'],
  '#e8f1fb',
  '#2f6db3',
);
// web
box(
  340,
  60,
  230,
  120,
  'Web application',
  ['Angular', 'Displays; never computes', 'a liability'],
  '#eaf6ee',
  '#2e8b57',
);
// api
box(
  640,
  20,
  300,
  300,
  'API (modular monolith)',
  [
    'NestJS / TypeScript',
    '',
    'Tax assessment: cases, evidence,',
    '  calculation, approval, notices,',
    '  deadlines, disputes, closure,',
    '  selection, portal, reports',
    'Forms: templates and submissions',
    'Workflow: engine client, inbox',
    'Platform: identity, authorisation,',
    '  audit, documents, exports, i18n',
  ],
  '#fff4e0',
  '#b86e00',
);
// right side services
box(1000, 20, 180, 70, 'PostgreSQL', ['System of record'], '#eceff3', '#3f4957');
box(1000, 105, 180, 70, 'Redis', ['Permission cache, queues'], '#eceff3', '#3f4957');
box(1000, 190, 180, 70, 'Object storage', ['Notice PDFs (S3/MinIO)'], '#eceff3', '#3f4957');
box(1000, 275, 180, 70, 'Keycloak', ['Identity, MFA flows'], '#eceff3', '#3f4957');
// worker, engine
box(
  640,
  370,
  300,
  90,
  'Worker',
  ['Same modules, no web port', 'Six scheduled jobs'],
  '#fff4e0',
  '#b86e00',
);
box(
  340,
  370,
  230,
  120,
  'Workflow engine',
  ['Flowable 7 (Java)', 'Who acts, when; timers', 'No tax logic'],
  '#efeafb',
  '#6a4bb3',
);
box(1000, 380, 180, 70, 'E-mail (SMTP)', ['Notifications'], '#eceff3', '#3f4957');
// external future
box(
  20,
  520,
  1160,
  100,
  'External systems (behind provider interfaces; planned)',
  [
    'Filing system · payment ledger / revenue accounting · taxpayer registry · digital signature · SMS gateway · captcha',
    'Today the two evidence providers read the platform’s own tables; each external system plugs in through its interface without changing the tax logic.',
  ],
  '#fafafa',
  '#6b7280',
  true,
);
// arrows
arrow([
  [280, 65],
  [340, 100],
]);
arrow([
  [280, 175],
  [340, 140],
]);
arrow(
  [
    [570, 120],
    [640, 120],
  ],
  true,
  'HTTPS',
  588,
  110,
);
arrow(
  [
    [940, 55],
    [1000, 55],
  ],
  true,
);
arrow(
  [
    [940, 140],
    [1000, 140],
  ],
  true,
);
arrow(
  [
    [940, 225],
    [1000, 225],
  ],
  true,
);
arrow(
  [
    [940, 305],
    [1000, 305],
  ],
  true,
);
arrow(
  [
    [790, 320],
    [790, 370],
  ],
  true,
);
arrow(
  [
    [640, 300],
    [455, 300],
    [455, 370],
  ],
  true,
  'start, messages / call-backs',
  470,
  292,
);
arrow([
  [940, 415],
  [1000, 415],
]);
arrow(
  [
    [790, 460],
    [790, 520],
  ],
  true,
  'provider interfaces',
  800,
  500,
);
p.push('</svg>');
fs.writeFileSync(path.join(outDir, 'architecture.svg'), p.join('\n'));
console.log('ok');
