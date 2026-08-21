import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Button } from './button';

describe('Button touch targets', () => {
  it.each(['default', 'sm', 'icon'] as const)('keeps the %s size at least 44px high', (size) => {
    render(<Button size={size}>操作</Button>);
    const button = screen.getByRole('button', { name: '操作' });

    expect(button).toHaveClass('min-h-11');
    expect(button).not.toHaveClass('h-10', 'min-h-10');
  });
});
