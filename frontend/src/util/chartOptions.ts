/** Shared ECharts option builder and mark helpers for temperature charts. */

import type { ChartScheme } from './chartTheme'
import type { Point } from './chartFormatting'
import { fmtTemp, fmtAxisTime } from './chartFormatting'

export interface BaseOptionOverrides {
  dataZoomStart?: number       // 0 (session) vs 80 (live)
  seriesActualName?: string    // 'Actual' vs 'Actual (profile)'
  seriesEmphasis?: boolean     // true for live chart
}

export function buildBaseOption(
  scheme: ChartScheme,
  unitRef: { current: string },
  overrides?: BaseOptionOverrides,
): Record<string, unknown> {
  const start = overrides?.dataZoomStart ?? 0
  const actualName = overrides?.seriesActualName ?? 'Actual'
  const emphasis = overrides?.seriesEmphasis ? { focus: 'series' as const } : undefined

  return {
    animation: false,
    grid: { left: 58, right: 14, top: 34, bottom: 54 },
    brush: {
      toolbox: [],
      xAxisIndex: 0,
      brushType: 'lineX',
      brushMode: 'single',
      transformable: false,
      throttleType: 'debounce',
      throttleDelay: 0,
      brushStyle: {
        borderWidth: 1,
        color: 'rgba(120, 140, 180, 0.15)',
        borderColor: 'rgba(120, 140, 180, 0.5)',
      },
    },
    legend: {
      top: 0,
      left: 0,
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { color: scheme.text, fontSize: 12 },
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line' },
      backgroundColor: scheme.tooltipBg,
      borderColor: scheme.tooltipBorder,
      textStyle: { color: scheme.textStrong },
      valueFormatter: (v: unknown) => {
        const u = unitRef.current
        return typeof v === 'number' && Number.isFinite(v) ? `${fmtTemp(v)}°${u}` : '--'
      },
    },
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'none',
        start,
        end: 100,
        zoomOnMouseWheel: 'ctrl',
        moveOnMouseWheel: true,
      },
      {
        type: 'slider',
        xAxisIndex: 0,
        start,
        end: 100,
        height: 18,
        bottom: 10,
        backgroundColor: scheme.zoomBg,
        borderColor: scheme.zoomBorder,
        fillerColor: scheme.zoomFill,
        handleStyle: { color: scheme.zoomHandle, borderColor: scheme.zoomHandleBorder },
        textStyle: { color: scheme.text },
        zoomOnMouseWheel: 'ctrl',
        moveOnMouseWheel: true,
      },
    ],
    xAxis: {
      type: 'time',
      minInterval: 60_000,
      axisLabel: {
        color: scheme.text,
        formatter: (v: number) => fmtAxisTime(v),
        hideOverlap: true,
      },
      axisLine: { lineStyle: { color: scheme.line } },
      splitLine: { lineStyle: { color: scheme.grid } },
    },
    yAxis: {
      type: 'value',
      boundaryGap: ['10%', '10%'],
      minInterval: 0.5,
      axisLabel: {
        color: scheme.text,
        formatter: (v: number) => {
          const u = unitRef.current
          return Number.isFinite(v) ? `${fmtTemp(v)}°${u}` : '--'
        },
      },
      axisLine: { lineStyle: { color: scheme.line } },
      splitLine: { lineStyle: { color: scheme.grid } },
    },
    series: [
      {
        name: actualName,
        type: 'line',
        showSymbol: false,
        itemStyle: { color: scheme.seriesActual },
        lineStyle: { width: 2, color: scheme.seriesActual },
        ...(emphasis ? { emphasis } : {}),
        data: [] as Point[],
        sampling: 'lttb',
      },
      {
        name: 'Cooldown tail',
        type: 'line',
        showSymbol: false,
        itemStyle: { color: scheme.seriesTail },
        lineStyle: { width: 2, color: scheme.seriesTail },
        ...(emphasis ? { emphasis } : {}),
        data: [] as Point[],
        sampling: 'lttb',
      },
      {
        name: 'Target',
        type: 'line',
        showSymbol: false,
        itemStyle: { color: scheme.seriesTarget },
        lineStyle: { width: 2, type: 'dashed', color: scheme.seriesTarget },
        ...(emphasis ? { emphasis } : {}),
        data: [] as Point[],
        sampling: 'lttb',
      },
      {
        name: 'Schedule',
        type: 'line',
        z: 1,
        showSymbol: true,
        symbolSize: 6,
        symbol: 'circle',
        itemStyle: { color: scheme.seriesSchedule },
        lineStyle: { width: 1.5, type: 'dotted', color: scheme.seriesSchedule },
        ...(emphasis ? { emphasis } : {}),
        data: [] as Point[],
      },
    ],
  }
}

export function buildMarkLine(endMs: number, scheme: ChartScheme) {
  return {
    silent: true,
    symbol: ['none', 'none'],
    lineStyle: { color: scheme.markerLine, width: 2, type: 'solid' as const },
    label: {
      show: true,
      formatter: 'Profile end',
      color: scheme.markerLine,
      fontWeight: 800,
      padding: [2, 6, 2, 6],
      backgroundColor: scheme.markerLabelBg,
      borderColor: scheme.markerLabelBorder,
      borderWidth: 1,
      borderRadius: 8,
    },
    data: [{ xAxis: endMs }],
  }
}

export function buildMarkArea(endMs: number, maxMs: number, scheme: ChartScheme) {
  return {
    silent: true,
    itemStyle: { color: scheme.tailShade },
    label: {
      show: true,
      color: scheme.tailLabel,
      fontWeight: 800,
      formatter: 'Cooldown tail',
      position: 'insideTop' as const,
    },
    data: [[{ xAxis: endMs }, { xAxis: maxMs }]],
  }
}
