import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The assessment workbench, as an officer uses it.
 *
 * Plan reference: V2 section 18.2.
 *
 * Every method here does what a person does: it finds a control by the words
 * on it and clicks it. None of them call the API. A helper that shortcut the
 * screen would make the suite pass while the screen was broken, which is the
 * one thing these tests exist to prevent.
 */
export class Workbench {
  constructor(private readonly page: Page) {}

  /** Open the register and start a case. Returns its case number. */
  static async openCase(
    page: Page,
    options: { taxpayerId: number; taxType?: string; year: string },
  ): Promise<{ caseNumber: string; url: string }> {
    await page.goto('/cases');
    await page.getByRole('button', { name: 'Open a case' }).click();

    await page.locator('#new-taxpayer').fill(String(options.taxpayerId));
    await page.locator('#new-taxtype').fill(options.taxType ?? 'CIT');
    await page.locator('#new-year').fill(options.year);
    await page.locator('#new-type').selectOption('DESK');
    await page.locator('#new-trigger').selectOption('RISK');

    await page.getByRole('button', { name: 'Open case', exact: true }).click();

    // The register navigates straight into the workbench, because the next
    // thing anybody does with a new case is retrieve its evidence.
    await expect(page).toHaveURL(/\/cases\/\d+$/, { timeout: 20_000 });

    // The heading carries the case number and the status badge, so take the
    // reference rather than the whole line.
    const heading = await page.locator('h1').first().innerText();
    const caseNumber = (/TA\d+/.exec(heading) ?? [''])[0];

    return { caseNumber, url: page.url() };
  }

  /** The status shown in the case header. */
  async status(): Promise<string> {
    return (await this.page.locator('h1 .tas-badge').first().innerText()).trim();
  }

  async expectStatus(status: string): Promise<void> {
    await expect(this.page.locator('h1 .tas-badge').first()).toHaveText(status, {
      timeout: 20_000,
    });
  }

  /** Press a lifecycle action in the Actions bar. */
  async act(label: string): Promise<void> {
    await this.page.getByRole('button', { name: label, exact: true }).click();
  }

  /**
   * What the service said about the last action, under the Actions bar.
   *
   * By its own class rather than as "the muted text": the tab below carries
   * muted prose of its own, and so does the bar when it has nothing to offer.
   */
  actionNote(): Locator {
    return this.page.locator('.tas-action-note');
  }

  /** Press an action and expect the server to refuse it. */
  async actAndExpectRefusal(label: string, expected: RegExp): Promise<void> {
    await this.act(label);
    await expect(this.page.locator('.tas-alert--danger')).toContainText(expected, {
      timeout: 20_000,
    });
  }

  async tab(name: string): Promise<void> {
    await this.page.getByRole('tab', { name, exact: true }).click();
  }

  async retrieveEvidence(): Promise<void> {
    await this.tab('Evidence');
    await this.page.getByRole('button', { name: 'Retrieve evidence' }).click();
    // The button reports its own progress, so waiting for it to settle is
    // waiting for the fan-out to finish.
    await expect(this.page.getByRole('button', { name: 'Retrieve evidence' })).toBeEnabled({
      timeout: 30_000,
    });
  }

  async calculate(): Promise<void> {
    await this.tab('Calculation');
    await this.page.getByRole('button', { name: 'Calculate', exact: true }).click();
    await expect(this.page.getByRole('button', { name: 'Calculate', exact: true })).toBeEnabled({
      timeout: 30_000,
    });
  }

  /** Record an adjustment through the DynaForms-rendered form. */
  async addAdjustment(options: {
    type: string;
    reason: string;
    amount: string;
    direction: 'ADD' | 'DEDUCT';
    narrative: string;
  }): Promise<void> {
    await this.tab('Adjustments');

    const form = this.page.locator('tas-form-renderer');
    await expect(form, 'the adjustment form is a published template').toBeVisible({
      timeout: 20_000,
    });

    await form.getByLabel('Adjustment type').selectOption(options.type);
    await form.getByLabel('Reason').selectOption(options.reason);
    await form.getByLabel('Amount').fill(options.amount);
    await form.getByLabel('Direction').selectOption(options.direction);
    await form.getByLabel('Narrative').fill(options.narrative);

    await this.page.getByRole('button', { name: 'Record adjustment' }).click();
    await expect(this.page.locator('tbody tr').first()).toBeVisible({ timeout: 20_000 });
  }
}
