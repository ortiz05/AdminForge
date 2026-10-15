/**
 * ECharts, loaded on demand by <Chart>. Only the chart types and components we use are registered,
 * and the three token themes are registered once from @adminforge/design-tokens.
 */
import { BarChart, LineChart } from 'echarts/charts';
import { AriaComponent, DatasetComponent, GridComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { emitEchartsTheme, THEME_NAMES } from '@adminforge/design-tokens';

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

export { echarts };
export type ECharts = ReturnType<typeof echarts.init>;
