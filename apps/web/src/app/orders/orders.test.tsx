import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import OrdersPage from './page';
import { api } from '@/lib/api';

vi.mock('next/navigation', () => ({
  usePathname: () => '/orders',
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: { ...actual.api, listOrders: vi.fn() } };
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OrdersPage />
    </QueryClientProvider>,
  );
}

describe('OrdersPage', () => {
  it('does not issue an unscoped orders request when projectId is absent', () => {
    renderPage();
    expect(api.listOrders).not.toHaveBeenCalled();
    expect(screen.getByText('请先从项目详情进入订单')).toBeInTheDocument();
  });
});
