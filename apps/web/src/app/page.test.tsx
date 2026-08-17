import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import HomePage from './page';

describe('HomePage', () => {
  it('identifies the product and reports that the web skeleton is ready', () => {
    render(<HomePage />);

    expect(screen.getByRole('heading', { name: '项目运营中心' })).toBeInTheDocument();
    expect(screen.getByText('网站基础骨架已就绪')).toBeInTheDocument();
  });
});
