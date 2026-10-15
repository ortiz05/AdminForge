/**
 * ECharts, loaded on demand by <Chart>. Only the chart types and components we use are registered,
 * and the three token themes are registered once from @adminforge/design-tokens.
 *
 * Registration happens inside `loadEcharts()`, not at module top level: this package declares
 * `"sideEffects": ["*.css"]`, so production bundlers may drop top-level calls whose effect they can't see
 * (`echarts.use` only mutates ECharts' own registries). That left every chart without a renderer
 * ("… is not a constructor") in production builds while the dev server worked.
 */
import { BarChart, LineChart } from 'echarts/charts';
import { AriaComponent, DatasetComponent, GridComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { emitEchartsTheme, THEME_NAMES } from '@adminforge/design-tokens';

let registered = false;

/** ECharts with our chart types, components, SVG renderer and token themes registered (idempotent). */
export function loadEcharts(): typeof echarts {
  if (!registered) {
    echarts.use([
      LineChart,
      BarChart,
      GridComponent,
      TooltipComponent,
      DatasetComponent,
      AriaComponent,
      SVGRenderer,
    ]);
    for (const name of THEME_NAMES) echarts.registerTheme(`af-${name}`, emitEchartsTheme(name));
    registered = true;
  }
  return echarts;
}

export type ECharts = ReturnType<typeof echarts.init>;
