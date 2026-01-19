/**
 * Design tokens matching the web UI (packages/ui/src/styles/index.css)
 * This ensures visual consistency between web and mobile platforms.
 */

export const colors = {
  // Color System - Neutral Dark Blacks
  void: '#06060a',
  bgPrimary: '#0a0a0e',
  bgSecondary: '#0e0e12',
  bgElevated: '#131317',
  bgSurface: '#18181c',
  bgHover: '#1e1e23',

  // Accent - Desaturated Sage
  accent: '#8fb8a8',
  accentDim: '#6d9486',
  accentGlow: 'rgba(143, 184, 168, 0.14)',
  accentSubtle: 'rgba(143, 184, 168, 0.08)',

  // Status Colors - Muted Pastels
  statusIdle: '#5c5c64',
  statusRunning: '#7ba888',
  statusBlocked: '#c4a67a',
  statusFailed: '#b8787d',

  // Text - Warm Cream Tones
  textPrimary: '#e6e2da',
  textSecondary: '#a8a49c',
  textMuted: '#6b6862',

  // Borders - Neutral
  border: '#252528',
  borderSubtle: '#1a1a1d',
  borderStrong: '#323236',

  // Surface Details
  grid: 'rgba(255, 255, 255, 0.025)',
  noise: 'rgba(255, 255, 255, 0.015)',
  bgHighlight: 'rgba(255, 255, 255, 0.04)',
  bgShade: 'rgba(0, 0, 0, 0.4)',

  // Semantic Status Colors (for status dots, badges)
  statusColors: {
    idle: '#5c5c64',
    running: '#7ba888',
    blocked: '#c4a67a',
    failed: '#b8787d',
    paused: '#c4a67a',
    completed: '#7ba888',
    queued: '#5c5c64',
  } as Record<string, string>,

  // UI accents for interactive elements
  linkBlue: '#60a5fa',
  thinkingGreen: '#4de6a8',
  streamingBlue: '#60a5fa',

  // Provider badge colors
  providerColors: {
    claude: {
      bg: 'rgba(196, 144, 128, 0.1)',
      border: 'rgba(196, 144, 128, 0.35)',
      text: '#c49080',
    },
    codex: {
      bg: 'rgba(122, 168, 138, 0.1)',
      border: 'rgba(122, 168, 138, 0.35)',
      text: '#7aa88a',
    },
    gemini: {
      bg: 'rgba(138, 159, 196, 0.1)',
      border: 'rgba(138, 159, 196, 0.35)',
      text: '#8a9fc4',
    },
    custom: {
      bg: '#131317', // bgElevated
      border: '#323236', // borderStrong
      text: '#6b6862', // textMuted
    },
  } as Record<string, { bg: string; border: string; text: string }>,
} as const;

export const spacing = {
  px: 1,
  xs: 2,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  '2xl': 20,
  '3xl': 24,
  '4xl': 32,
} as const;

export const fontSize = {
  xs: 10,
  sm: 11,
  base: 12,
  md: 13,
  lg: 14,
  xl: 15,
  '2xl': 16,
  '3xl': 18,
  '4xl': 20,
  '5xl': 22,
  '6xl': 24,
} as const;

export const radius = {
  sm: 2,
  md: 4,
  lg: 6,
  xl: 8,
  '2xl': 10,
  '3xl': 12,
  '4xl': 16,
  full: 9999,
} as const;

export const fontWeight = {
  normal: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
};

/**
 * Font family names matching web UI
 * These are loaded in _layout.tsx via expo-font
 */
export const fontFamily = {
  // IBM Plex Sans - body/display text
  regular: 'IBMPlexSans_400Regular',
  medium: 'IBMPlexSans_500Medium',
  semibold: 'IBMPlexSans_600SemiBold',
  bold: 'IBMPlexSans_700Bold',
  // Space Mono - code/terminal text
  mono: 'SpaceMono_400Regular',
  monoBold: 'SpaceMono_700Bold',
} as const;

// Helper to get status color with fallback
export function getStatusColor(status: string): string {
  return colors.statusColors[status] ?? colors.statusIdle;
}

// Helper to get provider colors with fallback
export function getProviderColors(provider: string): { bg: string; border: string; text: string } {
  const providerColor = colors.providerColors[provider];
  if (providerColor) return providerColor;
  return colors.providerColors.custom as { bg: string; border: string; text: string };
}
