import { Injectable, signal } from '@angular/core';

/**
 * Work in progress that has not reached the server.
 *
 * Plan reference: V2 section 18.3 ("draft autosave on the workbench";
 * "draft submissions survive a lost connection and resubmit").
 *
 * ## What this is for
 *
 * An officer types a justification for an adjustment, the laptop sleeps, the
 * VPN drops, the tab is closed by accident. Without this, the work is gone and
 * the officer types it again — which in practice means they type less of it.
 * The narrative on an adjustment is the part of an assessment that gets
 * defended in a hearing, so losing it has a cost beyond the annoyance.
 *
 * ## Why localStorage and not the server
 *
 * A draft is not a submission. Sending every keystroke to the API would create
 * half-formed adjustments in the register, and a case history full of rows
 * nobody meant to record. Keeping drafts in the browser means nothing reaches
 * the audit trail until the officer decides it should.
 *
 * The trade-off is stated plainly rather than hidden: a draft is on **this**
 * machine, in **this** browser. It does not follow the officer to another
 * desk, and the screens that use it say so.
 *
 * ## Why nothing financial is ever restored silently
 *
 * A restored draft is shown as a restored draft, with the option to discard
 * it. An amount that reappears in a field without the officer knowing where it
 * came from is worse than an empty field.
 */

/** Drafts older than this are not offered back. */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const PREFIX = 'tas.draft.';

interface StoredDraft {
  readonly savedAt: number;
  readonly values: Record<string, unknown>;
}

export interface RestoredDraft {
  readonly values: Record<string, unknown>;
  readonly savedAt: Date;
}

@Injectable({ providedIn: 'root' })
export class DraftStore {
  /**
   * Whether the browser believes it is online.
   *
   * Exposed so a screen can tell an officer that their work is being held
   * locally, rather than letting them submit into a void.
   */
  readonly online = signal(typeof navigator === 'undefined' ? true : navigator.onLine);

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.online.set(true));
      window.addEventListener('offline', () => this.online.set(false));
    }
  }

  /**
   * Keep a draft.
   *
   * Storage failures are swallowed. A full quota or a browser in private mode
   * must not stop an officer working; autosave is a convenience and it fails
   * to nothing rather than to an error dialogue.
   */
  save(key: string, values: Record<string, unknown>): void {
    try {
      const draft: StoredDraft = { savedAt: Date.now(), values };
      localStorage.setItem(`${PREFIX}${key}`, JSON.stringify(draft));
    } catch {
      // Deliberately ignored. See above.
    }
  }

  /** A draft, if there is a recent one. */
  load(key: string): RestoredDraft | null {
    try {
      const raw = localStorage.getItem(`${PREFIX}${key}`);
      if (raw === null) {
        return null;
      }

      const draft = JSON.parse(raw) as StoredDraft;
      if (Date.now() - draft.savedAt > STALE_AFTER_MS) {
        // A week-old draft is more likely to confuse than to help: the case
        // has moved on and the figures in it may no longer be arguable.
        this.clear(key);
        return null;
      }

      return { values: draft.values, savedAt: new Date(draft.savedAt) };
    } catch {
      return null;
    }
  }

  clear(key: string): void {
    try {
      localStorage.removeItem(`${PREFIX}${key}`);
    } catch {
      // Ignored, as above.
    }
  }

  /**
   * Submit, and keep the draft if the attempt fails for a reason that might
   * pass later.
   *
   * A rejected submission — a 400, a 409, a refused transition — is not a
   * connection problem and the draft is kept for the officer to correct. A
   * network failure keeps it too. What clears a draft is the server accepting
   * it, and nothing else.
   */
  async submit<T>(
    key: string,
    values: Record<string, unknown>,
    send: () => Promise<T>,
  ): Promise<T> {
    // Saved *before* the attempt, so a tab that dies mid-request still has it.
    this.save(key, values);
    const result = await send();
    this.clear(key);
    return result;
  }
}
