/** Unified chart colour scheme for both LiveTempChart and RecentSessionChart. */

export type ChartScheme = {
  seriesActual: string
  seriesTarget: string
  seriesSchedule: string
  seriesTail: string
  seriesPower: string

  text: string
  textStrong: string
  line: string
  grid: string

  tooltipBg: string
  tooltipBorder: string

  zoomBg: string
  zoomBorder: string
  zoomFill: string
  zoomHandle: string
  zoomHandleBorder: string

  markerLine: string
  markerLabelBg: string
  markerLabelBorder: string
  tailShade: string
  tailLabel: string
}

export function schemeForTheme(theme: 'stoneware' | 'dark'): ChartScheme {
  if (theme === 'stoneware') {
    return {
      seriesActual: 'rgba(56, 109, 140, 0.95)',
      seriesTarget: 'rgba(138, 90, 68, 0.95)',
      seriesSchedule: 'rgba(90, 140, 90, 0.70)',
      seriesTail: 'rgba(143, 132, 121, 0.92)',
      seriesPower: 'rgba(160, 94, 188, 0.85)',

      text: 'rgba(45, 35, 28, 0.72)',
      textStrong: 'rgba(45, 35, 28, 0.92)',
      line: 'rgba(70, 55, 44, 0.22)',
      grid: 'rgba(70, 55, 44, 0.08)',

      tooltipBg: 'rgba(251, 248, 242, 0.98)',
      tooltipBorder: 'rgba(70, 55, 44, 0.16)',

      zoomBg: 'rgba(70, 55, 44, 0.04)',
      zoomBorder: 'rgba(70, 55, 44, 0.14)',
      zoomFill: 'rgba(138, 90, 68, 0.16)',
      zoomHandle: 'rgba(138, 90, 68, 0.45)',
      zoomHandleBorder: 'rgba(138, 90, 68, 0.22)',

      markerLine: 'rgba(138, 90, 68, 0.85)',
      markerLabelBg: 'rgba(251, 248, 242, 0.92)',
      markerLabelBorder: 'rgba(138, 90, 68, 0.25)',
      tailShade: 'rgba(143, 132, 121, 0.10)',
      tailLabel: 'rgba(70, 55, 44, 0.62)',
    }
  }

  // dark
  return {
    seriesActual: 'rgba(75, 160, 255, 0.95)',
    seriesTarget: 'rgba(240, 176, 74, 0.95)',
    seriesSchedule: 'rgba(120, 200, 120, 0.70)',
    seriesTail: 'rgba(184, 198, 214, 0.92)',
    seriesPower: 'rgba(180, 120, 255, 0.85)',

    text: 'rgba(255, 255, 255, 0.78)',
    textStrong: 'rgba(255, 255, 255, 0.92)',
    line: 'rgba(255, 255, 255, 0.16)',
    grid: 'rgba(255, 255, 255, 0.08)',

    tooltipBg: 'rgba(12, 18, 28, 0.92)',
    tooltipBorder: 'rgba(255, 255, 255, 0.14)',

    zoomBg: 'rgba(255, 255, 255, 0.06)',
    zoomBorder: 'rgba(255, 255, 255, 0.14)',
    zoomFill: 'rgba(240, 176, 74, 0.20)',
    zoomHandle: 'rgba(240, 176, 74, 0.65)',
    zoomHandleBorder: 'rgba(240, 176, 74, 0.35)',

    markerLine: 'rgba(240, 176, 74, 0.85)',
    markerLabelBg: 'rgba(12, 18, 28, 0.72)',
    markerLabelBorder: 'rgba(240, 176, 74, 0.25)',
    tailShade: 'rgba(184, 198, 214, 0.08)',
    tailLabel: 'rgba(184, 198, 214, 0.78)',
  }
}
