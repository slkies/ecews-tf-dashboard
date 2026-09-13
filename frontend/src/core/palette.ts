/**
 * Chart colours, per theme.
 *
 * Series identity uses a blue/orange pair that passes colour-vision checks on
 * both themes (validated against the card and page surfaces: adjacent
 * delta-E 24.7 light, 26.8 dark). The original app's female/male pair failed
 * those checks in both themes - too dark and grey on light, and two blues too
 * close to separate on dark - so it is not carried forward.
 *
 * Brand green is the accent, not a series colour: it marks the one thing a
 * chart is about (a single-series trend, a sparkline), never "series 3".
 * Status colours (good / warn / bad) are reserved for status and live in the
 * CSS tokens, never here.
 */
import { useTheme } from './theme'

export interface ChartPalette {
  primary: string      // brand green: single-series marks, sparklines
  female: string       // categorical slot 1
  male: string         // categorical slot 2
  unknown: string      // data gap, deliberately recessive
  provisional: string  // a period that has not finished happening
}

export const PALETTE_LIGHT: ChartPalette = {
  primary: '#08684E',
  female: '#2a78d6',
  male: '#eb6834',
  unknown: '#d6d5cc',
  provisional: '#8a897b',
}

export const PALETTE_DARK: ChartPalette = {
  primary: '#2BD39C',
  female: '#3987e5',
  male: '#d95926',
  unknown: '#44443c',
  provisional: '#8f8e82',
}

/** The palette for the current theme. Its identity changes with the theme,
 *  so a chart config memoised on it is rebuilt when the theme flips. */
export function useChartPalette(): ChartPalette {
  const { theme } = useTheme()
  return theme === 'dark' ? PALETTE_DARK : PALETTE_LIGHT
}

/** A CSS custom property's current value, for chart chrome that follows the
 *  page tokens (axis text, gridlines). */
export function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}
