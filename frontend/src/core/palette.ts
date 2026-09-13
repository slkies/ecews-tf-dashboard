/**
 * Chart colours, per theme. Copied from the existing dashboard so the two
 * apps draw the same series in the same colours.
 *
 * Accents keep their HUE between themes and are lifted in lightness for the
 * dark ground: the deep blue used for the female series scores ~2:1 on
 * near-black and is effectively invisible there, so each colour is re-picked
 * rather than reused.
 */
import { useTheme } from './theme'

export interface ChartPalette {
  green: string; honey: string; honeyInk: string
  brick: string; brickInk: string; slate: string; rule: string
  female: string; male: string; maleInk: string; other: string
  violet: string; violetInk: string; teal: string; tealInk: string
}

export const PALETTE_LIGHT: ChartPalette = {
  green: '#08684E', honey: '#EBA01E', honeyInk: '#9C6B08',
  brick: '#E24B3B', brickInk: '#B83B2A', slate: '#5B7FA6', rule: '#E6DFD4',
  female: '#1b4965', male: '#62b6cb', maleInk: '#256d80', other: '#00b4d8',
  violet: '#8250C9', violetInk: '#6A44A8', teal: '#12A0B8', tealInk: '#0B7C8C',
}

export const PALETTE_DARK: ChartPalette = {
  green: '#2BD39C', honey: '#E7B23C', honeyInk: '#E7B23C',
  brick: '#F2705A', brickInk: '#F2705A', slate: '#7FB3CC', rule: '#272B2C',
  female: '#6FA8CC', male: '#4FD3E6', maleInk: '#4FD3E6', other: '#57D9F2',
  violet: '#B49BE8', violetInk: '#B49BE8', teal: '#4FD3E6', tealInk: '#4FD3E6',
}

/** The palette for the current theme. Its identity changes with the theme,
 *  so a chart config memoised on it is rebuilt when the theme flips. */
export function useChartPalette(): ChartPalette {
  const { theme } = useTheme()
  return theme === 'dark' ? PALETTE_DARK : PALETTE_LIGHT
}

/** A CSS custom property's current value, for the few chart colours that
 *  come from the page tokens rather than the chart palette. */
export function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}
