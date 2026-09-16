import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  ViewChild,
  signal,
} from '@angular/core';
import BpmnViewer from 'bpmn-js/lib/NavigatedViewer';
import { FLOWABLE_MODDLE } from './flowable-moddle';

/**
 * A BPMN diagram, with progress marked on it.
 *
 * Plan reference: V2 section 18.1 screen 14 ("bpmn-js viewer with progress
 * overlay"), section 5.4.
 *
 * ## Why a viewer and not a picture
 *
 * The question an officer asks about a stuck case is "where is it, and what
 * is it waiting for". A screenshot of the process cannot answer that; the
 * diagram with the current step highlighted can, and it is the same diagram
 * the process was authored on, so the answer cannot drift from the definition.
 *
 * ## Why `NavigatedViewer` rather than the full modeller
 *
 * This is a read-only surface. A modeller here would let an officer drag a
 * gateway on the screen where they are diagnosing a case, and the change would
 * do nothing — which is worse than not offering it. Pan and zoom are what a
 * reader of a large diagram actually needs.
 */
@Component({
  selector: 'tas-bpmn-diagram',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (failure(); as message) {
      <p class="tas-muted">{{ message }}</p>
    }
    <div #canvas class="tas-bpmn" [style.height.px]="height"></div>
  `,
  styles: [
    `
      .tas-bpmn {
        width: 100%;
        border: 1px solid var(--tas-border, #e2e8f0);
        border-radius: 6px;
        background: #fff;
      }
      /* The overlay classes. Deliberately strong: this is the whole point of
         drawing the diagram rather than listing the steps. */
      :host ::ng-deep .tas-activity-done .djs-visual > :first-child {
        fill: #dcfce7 !important;
        stroke: #16a34a !important;
      }
      :host ::ng-deep .tas-activity-active .djs-visual > :first-child {
        fill: #fef3c7 !important;
        stroke: #d97706 !important;
        stroke-width: 3px !important;
      }
    `,
  ],
})
export class BpmnDiagram implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLElement>;

  @Input({ required: true }) bpmnXml: string | null = null;
  @Input() completed: readonly string[] = [];
  @Input() active: readonly string[] = [];
  @Input() height = 420;

  readonly failure = signal<string | null>(null);

  private viewer: BpmnViewer | null = null;

  ngAfterViewInit(): void {
    void this.draw();
  }

  ngOnChanges(): void {
    if (this.viewer !== null || this.canvasRef !== undefined) {
      void this.draw();
    }
  }

  ngOnDestroy(): void {
    this.viewer?.destroy();
    this.viewer = null;
  }

  private async draw(): Promise<void> {
    if (this.bpmnXml === null || this.bpmnXml === '') {
      return;
    }

    this.viewer?.destroy();
    this.viewer = new BpmnViewer({
      container: this.canvasRef.nativeElement,
      moddleExtensions: { flowable: FLOWABLE_MODDLE },
    });

    try {
      // The XML arrives with coordinates: the API lays out a definition that
      // has none before returning it, so that the journey screen, the
      // modeller and anything else drawing a diagram get the same arrangement
      // from one implementation rather than three.
      await this.viewer.importXML(this.bpmnXml);
      const canvas = this.viewer.get('canvas') as {
        zoom: (mode: string) => void;
        addMarker: (id: string, marker: string) => void;
      };
      canvas.zoom('fit-viewport');

      // Completed first, then active, so an activity that has run more than
      // once — a rework loop — shows as active rather than done. The current
      // state is what the reader is looking for.
      for (const activityId of this.completed) {
        canvas.addMarker(activityId, 'tas-activity-done');
      }
      for (const activityId of this.active) {
        canvas.addMarker(activityId, 'tas-activity-active');
      }

      this.failure.set(null);
    } catch (error) {
      // A diagram that will not render is not a reason to lose the page. The
      // journey tab shows the step list underneath it either way, and that
      // list is the fact — the diagram is the illustration.
      this.failure.set(
        `The diagram could not be drawn (${
          error instanceof Error ? error.message : 'unknown error'
        }). The steps below are unaffected.`,
      );
    }
  }
}

/**
 * Does this definition carry coordinates?
 *
 * A string test rather than a parse: the answer decides whether to run a
 * layout, and parsing twice to find out would cost more than the check saves.
 */
function hasDiagramInterchange(xml: string): boolean {
  return /<(?:\w+:)?BPMNDiagram/.test(xml);
}
