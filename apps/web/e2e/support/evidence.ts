import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page } from '@playwright/test';

/**
 * The record a documented run leaves behind.
 *
 * Plan reference: V2 section 26.1.
 *
 * A screenshot on its own proves nothing: it shows a screen without saying
 * what was asked of it or what the answer was supposed to be. So every step
 * carries the actor, the transition it drives, what proves it, and the status
 * the server held afterwards. The PDF is rendered from these records, which
 * means the document cannot drift from the run that produced it.
 */
export interface EvidenceStep {
  readonly n: number;
  readonly id: string;
  readonly title: string;
  readonly actor: string;
  /** `FROM --ACTION--> TO` for a lifecycle move, null for a refusal or a look. */
  readonly transition: string | null;
  readonly kind: 'transition' | 'refusal' | 'observation';
  readonly description: string;
  /** What this step is asserting. The sentence a reviewer checks the shot against. */
  readonly expected: string;
  readonly screenshot: string;
  readonly statusAfter: string | null;
  readonly at: string;
}

export const EVIDENCE_DIR = join(process.cwd(), 'docs', 'e2e-evidence');
const SHOTS_DIR = join(EVIDENCE_DIR, 'screenshots');
const STEPS_FILE = join(EVIDENCE_DIR, 'steps.json');

/**
 * Collects steps across a run.
 *
 * Steps are appended to the file as they happen rather than written once at
 * the end, so a run that dies half way still documents what it proved before
 * it died. That is the failure mode worth designing for: the interesting runs
 * are the ones that stop somewhere unexpected.
 */
export class EvidenceRecorder {
  private steps: EvidenceStep[] = [];

  /** Start a fresh run. Old screenshots go, so the PDF can never mix two runs. */
  static reset(): void {
    if (existsSync(EVIDENCE_DIR)) {
      rmSync(EVIDENCE_DIR, { recursive: true, force: true });
    }
    mkdirSync(SHOTS_DIR, { recursive: true });
  }

  static load(): EvidenceStep[] {
    return existsSync(STEPS_FILE)
      ? (JSON.parse(readFileSync(STEPS_FILE, 'utf8')) as EvidenceStep[])
      : [];
  }

  constructor() {
    this.steps = EvidenceRecorder.load();
  }

  async capture(
    page: Page,
    step: Omit<EvidenceStep, 'n' | 'screenshot' | 'at'>,
  ): Promise<EvidenceStep> {
    const n = this.steps.length + 1;
    const file = `${String(n).padStart(2, '0')}-${step.id}.png`;
    const absolute = join(SHOTS_DIR, file);

    mkdirSync(dirname(absolute), { recursive: true });
    await page.screenshot({ path: absolute, fullPage: true });

    const recorded: EvidenceStep = {
      ...step,
      n,
      screenshot: join('screenshots', file).split('\\').join('/'),
      at: new Date().toISOString(),
    };

    this.steps.push(recorded);
    writeFileSync(STEPS_FILE, `${JSON.stringify(this.steps, null, 2)}\n`);
    return recorded;
  }
}
