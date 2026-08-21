export const colors = {
  navy: '#0F2747',
  navyStrong: '#091B33',
  primary: '#1D4ED8',
  primaryHover: '#1E40AF',
  page: '#F4F6F8',
  surface: '#FFFFFF',
  surfaceSubtle: '#F8FAFC',
  text: '#172033',
  textMuted: '#627187',
  border: '#D8DEE8',
  borderStrong: '#B8C2D1',
  success: '#047857',
  warning: '#B45309',
  danger: '#B42318',
  info: '#2563EB',
} as const;

export const spacing = {
  1: '4px',
  2: '8px',
  3: '12px',
  4: '16px',
  6: '24px',
  8: '32px',
} as const;

export const radii = {
  control: '8px',
  card: '12px',
  pill: '999px',
} as const;

export const shadows = {
  card: '0 1px 2px rgb(15 39 71 / 4%), 0 8px 24px rgb(15 39 71 / 6%)',
  overlay: '0 20px 48px rgb(9 27 51 / 22%)',
} as const;

function relativeLuminance(hex: string): number {
  const normalized = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(normalized)) {
    throw new Error(`Expected a six-digit hexadecimal colour, received: ${hex}`);
  }

  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });

  const [red = 0, green = 0, blue = 0] = channels;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG 2.x contrast ratio for two six-digit hexadecimal colours. */
export function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export type DesignColors = typeof colors;
