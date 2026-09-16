import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  ViewChild,
} from '@angular/core';
import ApexCharts from 'apexcharts';

/**
 * A chart.
 *
 * Plan reference: V2 section 18.1 screen 2 ("KPI tiles + ApexCharts").
 *
 * ## Why this wrapper exists
 *
 * ApexCharts is an imperative library that owns a DOM node, and Angular is
 * not. Without a single wrapper, every screen that wants a chart ends up
 * creating one in `ngAfterViewInit`, forgetting to destroy it, and leaking a
 * resize listener per navigation. One component, one lifecycle.
 *
 * ## Why the series are numbers when everything else is strings
 *
 * A chart is a picture. It cannot draw an exact decimal, and a bar is
 * accurate to a few pixels at best, so converting a monetary string to a
 * number *here* loses nothing that was not already lost by drawing it.
 *
 * What matters is that this is the only place it happens, and that the figure
 * an officer reads is never the one the chart drew: every screen that shows a
 * chart shows the exact string beside it. `toSeries` is the conversion, it is
 * named, and it is confined to presentation (ADR-007).
 */
@Component({
  selector: 'tas-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div #host [style.min-height.px]="height"></div>`,
})
export class Chart implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('host', { static: true }) host!: ElementRef<HTMLElement>;

  @Input({ required: true }) type: 'bar' | 'line' | 'area' | 'donut' = 'bar';
  @Input({ required: true }) series: readonly unknown[] = [];
  @Input() labels: readonly string[] = [];
  @Input() height = 280;
  @Input() horizontal = false;
  @Input() colours: readonly string[] = ['#2563eb', '#0d9488', '#d97706', '#dc2626'];
  /** Shown under the cursor. Kept separate so amounts can be exact there. */
  @Input() tooltipFormatter?: (value: number, index: number) => string;

  private chart: ApexCharts | null = null;

  ngAfterViewInit(): void {
    this.draw();
  }

  ngOnChanges(): void {
    // Only after the first render: the view child does not exist before it.
    if (this.chart !== null) {
      this.draw();
    }
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
    this.chart = null;
  }

  private draw(): void {
    this.chart?.destroy();

    const formatter = this.tooltipFormatter;

    this.chart = new ApexCharts(this.host.nativeElement, {
      chart: {
        type: this.type,
        height: this.height,
        // No toolbar: exporting a chart as a PNG is not an audit trail, and
        // the register export is the supported way to take figures away.
        toolbar: { show: false },
        fontFamily: 'inherit',
        animations: { enabled: false },
      },
      series: this.series,
      labels: [...this.labels],
      colors: [...this.colours],
      plotOptions: { bar: { horizontal: this.horizontal, borderRadius: 3 } },
      dataLabels: { enabled: false },
      stroke: { width: this.type === 'line' ? 2 : 1, curve: 'straight' },
      xaxis: this.type === 'donut' ? {} : { categories: [...this.labels] },
      legend: { position: 'bottom' },
      noData: { text: 'Nothing to show yet' },
      tooltip:
        formatter === undefined
          ? {}
          : {
              y: {
                formatter: (value: number, options?: { dataPointIndex?: number }) =>
                  formatter(value, options?.dataPointIndex ?? 0),
              },
            },
    } as unknown as ApexCharts.ApexOptions);

    void this.chart.render();
  }
}

/**
 * A monetary string as a chart coordinate.
 *
 * Named, so that a reviewer can find every place a figure stops being exact.
 * Presentation only — nothing computed from this ever reaches a case.
 */
export function toSeries(amount: string | null | undefined): number {
  if (amount === null || amount === undefined || amount === '') {
    return 0;
  }
  const parsed = Number(amount);
  return Number.isFinite(parsed) ? parsed : 0;
}
