/**
 * Shared design scales. Breakpoints are a deliberately small set: 600 for the
 * compact shell, 700 for the rail/workspace split, and 760 for the two-column
 * memory overview. Icon sizes use one control scale so a new icon does not add
 * another 15/17/19px step.
 */
export const BREAKPOINTS = {
  compact: 600,
  rail: 700,
  tablet: 760
} as const

export const ICON_SIZE = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 24,
  xxl: 40
} as const
