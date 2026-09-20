import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { Background, MAX_IMAGE_BYTES, isImageDataUrl } from '../core/theme';
import { SCENES, findScene } from '../core/theme-scenes';
import { ThemeService } from '../core/theme.service';

const UNREADABLE = 'That image could not be read. Try another file.';

const DEFAULT_COLOUR = '#1f4e79';

/** The option value that stands for the current background in the select. */
function optionOf(background: Background): string {
  return background.kind === 'preset' ? background.id : background.kind;
}

function describeBackground(background: Background): string {
  switch (background.kind) {
    case 'none':
      return 'no background';
    case 'colour':
      return 'a colour';
    case 'preset':
      return findScene(background.id)?.name ?? 'a scene';
    case 'image':
      return 'your image';
  }
}

/**
 * Theme, background and veil, from the shell header.
 *
 * Plan reference: V2 section 18.3.
 *
 * A `<details>` rather than a custom menu: the browser already gives it
 * keyboard opening, Escape handling on the summary and the right roles, and
 * every line of a hand-built popup would be a line of that behaviour rewritten
 * less well.
 */
@Component({
  selector: 'tas-appearance',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <details class="tas-appearance" #panel (keydown.escape)="close(panel)">
      <summary
        class="tas-btn tas-appearance__trigger"
        [attr.aria-label]="summaryLabel()"
        [attr.title]="summaryLabel()"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.5" />
          <path d="M8 1.6a6.4 6.4 0 0 0 0 12.8z" fill="currentColor" />
        </svg>
      </summary>

      <div class="tas-appearance__panel">
        <fieldset class="tas-appearance__group">
          <legend>Theme</legend>
          <div class="tas-appearance__choices">
            <div>
              <input
                type="radio"
                name="tas-appearance-mode"
                id="tas-appearance-mode-light"
                [checked]="preference().mode === 'light'"
                (change)="theme.setMode('light')"
              />
              <label for="tas-appearance-mode-light">Light</label>
            </div>
            <div>
              <input
                type="radio"
                name="tas-appearance-mode"
                id="tas-appearance-mode-dark"
                [checked]="preference().mode === 'dark'"
                (change)="theme.setMode('dark')"
              />
              <label for="tas-appearance-mode-dark">Dark</label>
            </div>
            <div>
              <input
                type="radio"
                name="tas-appearance-mode"
                id="tas-appearance-mode-system"
                [checked]="preference().mode === 'system'"
                (change)="theme.setMode('system')"
              />
              <label for="tas-appearance-mode-system">Match my device</label>
            </div>
          </div>
        </fieldset>

        <div class="tas-field">
          <label for="tas-appearance-background">Background</label>
          <select
            id="tas-appearance-background"
            #chosen
            [value]="backgroundSelection()"
            (change)="chooseBackground(chosen.value)"
          >
            <option value="none">None</option>
            <option value="colour">A colour</option>
            @for (scene of scenes; track scene.id) {
              <option [value]="scene.id">{{ scene.name }}</option>
            }
            <option value="image">An image from this device</option>
          </select>
        </div>

        @if (backgroundSelection() === 'colour') {
          <div class="tas-field">
            <label for="tas-appearance-colour">Colour</label>
            <input
              type="color"
              id="tas-appearance-colour"
              #swatch
              [value]="colour()"
              (input)="chooseColour(swatch.value)"
            />
          </div>
        }

        @if (backgroundSelection() === 'image') {
          <div class="tas-field">
            <label for="tas-appearance-image">Image from this device</label>
            <input
              type="file"
              id="tas-appearance-image"
              accept="image/*"
              (change)="chooseImage($event)"
            />
            <p class="tas-field__hint">Up to 2 MB. It is kept on this device only.</p>
            @if (imageError(); as message) {
              <p class="tas-alert tas-alert--danger" role="alert">{{ message }}</p>
            }
          </div>
        }

        <div class="tas-field">
          <label for="tas-appearance-veil">Veil {{ veilPercent() }}%</label>
          <input
            type="range"
            id="tas-appearance-veil"
            #veil
            min="0"
            max="100"
            step="5"
            [value]="veilPercent()"
            [disabled]="preference().background.kind === 'none'"
            (input)="theme.setVeil(+veil.value / 100)"
          />
          <p class="tas-field__hint">How strongly the page colour covers the background.</p>
        </div>
      </div>
    </details>
  `,
  styles: `
    .tas-appearance {
      position: relative;
    }

    /* 30px square is a measured budget, not a guess. The shell header has no
       horizontal slack at 1440px, and a wider trigger pushes the user block
       off the viewport. It matches the brand mark beside it for the same
       reason. */
    .tas-appearance__trigger {
      width: 30px;
      height: 30px;
      padding: 0;
      display: grid;
      place-items: center;
      list-style: none;

      &::-webkit-details-marker {
        display: none;
      }

      &::marker {
        content: '';
      }
    }

    .tas-appearance__panel {
      position: absolute;
      inset-inline-end: 0;
      top: calc(100% + 0.5rem);
      z-index: 50;
      width: 17rem;
      padding: 0.85rem;
      background: var(--tas-surface);
      border: 1px solid var(--tas-border);
      border-radius: 8px;
      box-shadow: 0 8px 24px rgb(0 0 0 / 0.18);
      display: flex;
      flex-direction: column;
      gap: 0.85rem;
      text-align: start;
    }

    .tas-appearance__group {
      border: 0;
      padding: 0;
      margin: 0;

      legend {
        padding: 0;
        font-weight: 600;
        font-size: 0.8rem;
        color: var(--tas-text-muted);
      }
    }

    .tas-appearance__choices {
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
      margin-block-start: 0.35rem;

      label {
        font-size: 0.85rem;
        color: var(--tas-text);
        margin-inline-start: 0.35rem;
      }
    }

    input[type='color'] {
      inline-size: 100%;
      block-size: 2rem;
    }

    input[type='range'] {
      inline-size: 100%;
    }

    .tas-alert {
      margin: 0.4rem 0 0;
      font-size: 0.8rem;
    }
  `,
})
export class AppearanceControl {
  readonly theme = inject(ThemeService);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly scenes = SCENES;

  readonly preference = this.theme.preference;

  readonly imageError = signal<string | null>(null);

  /**
   * Which option the select is showing.
   *
   * Linked rather than derived, because "An image from this device" has to be
   * selectable before there is an image: picking it reveals the file input
   * without blanking the background already on screen. Any change to the
   * stored preference wins over that local choice.
   */
  readonly backgroundSelection = linkedSignal<string>(() => optionOf(this.preference().background));

  readonly colour = computed(() => {
    const background = this.preference().background;
    return background.kind === 'colour' ? background.value : DEFAULT_COLOUR;
  });

  readonly veilPercent = computed(() => Math.round(this.preference().veil * 100));

  /** The current choice, readable without opening the panel. */
  readonly summaryLabel = computed(() => {
    const preference = this.preference();
    const mode = preference.mode === 'system' ? 'matching this device' : preference.mode;
    return `Appearance: ${mode}, ${describeBackground(preference.background)}`;
  });

  chooseBackground(value: string): void {
    this.backgroundSelection.set(value);
    this.imageError.set(null);

    if (value === 'none') {
      this.theme.setBackground({ kind: 'none' });
      return;
    }
    if (value === 'colour') {
      this.theme.setBackground({ kind: 'colour', value: this.colour() });
      return;
    }
    if (value === 'image') {
      // Nothing is applied until a file arrives. Blanking the background here
      // would punish an officer who opened the picker and changed their mind.
      return;
    }
    this.theme.setBackground({ kind: 'preset', id: value });
  }

  chooseColour(value: string): void {
    this.theme.setBackground({ kind: 'colour', value });
  }

  chooseImage(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file === undefined) return;

    this.imageError.set(null);

    // The input is cleared on every path, because one that still holds the
    // last file fires no `change` when the same file is picked again.
    if (!file.type.startsWith('image/')) {
      this.imageError.set('That file is not an image. Choose a PNG, JPEG or WebP.');
      input.value = '';
      return;
    }

    if (file.size > MAX_IMAGE_BYTES) {
      const size = (file.size / (1024 * 1024)).toFixed(1);
      this.imageError.set(
        `That image is ${size} MB. The limit is 2 MB, because it is stored in this browser. Resize it or choose a smaller one.`,
      );
      input.value = '';
      return;
    }

    // Cleared before the read rather than in the callbacks: an aborted or
    // synchronously failing read runs neither of them, and would leave a
    // selection that silently refuses the next pick of the same file. The
    // captured `File` stays readable afterwards.
    input.value = '';

    const reader = new FileReader();

    reader.onerror = () => {
      this.imageError.set(UNREADABLE);
    };

    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string' || !isImageDataUrl(result)) {
        this.imageError.set(UNREADABLE);
      } else if (!this.theme.setBackground({ kind: 'image', dataUrl: result })) {
        // The service put the previous preference back, so the rejected file
        // leaves the background that was already on screen untouched rather
        // than a half-applied one that the next reload would not have.
        this.imageError.set(
          'There was not room to store that image on this device. Choose a smaller one.',
        );
      }
    };

    reader.readAsDataURL(file);
  }

  close(panel: HTMLDetailsElement): void {
    panel.open = false;
    panel.querySelector<HTMLElement>('summary')?.focus();
  }

  @HostListener('document:pointerdown', ['$event'])
  closeOnOutsidePointer(event: Event): void {
    const target = event.target;
    if (target instanceof Node && this.host.nativeElement.contains(target)) return;
    const panel = this.host.nativeElement.querySelector('details');
    if (panel !== null) panel.open = false;
  }
}
