import { describe, expect, it } from 'vitest';

import { colors, contrastRatio } from '@project-operations/design-tokens';

describe('design token contrast', () => {
  it.each([
    ['正文 / 白色卡片', colors.text, colors.surface, 4.5],
    ['正文 / 页面底色', colors.text, colors.page, 4.5],
    ['辅助文字 / 页面底色', colors.textMuted, colors.page, 4.5],
    ['辅助文字 / 白色卡片', colors.textMuted, colors.surface, 4.5],
    ['侧栏文字 / 海军蓝', colors.surface, colors.navy, 4.5],
    ['主按钮文字 / 海军蓝', colors.surface, colors.navy, 4.5],
    ['危险提示 / 白色', colors.danger, colors.surface, 4.5],
    ['成功提示 / 白色', colors.success, colors.surface, 4.5],
  ])('%s meets WCAG AA', (_name, foreground, background, minimum) => {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(minimum);
  });
});
