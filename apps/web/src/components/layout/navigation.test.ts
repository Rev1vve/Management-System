import { describe, expect, it } from 'vitest';

import { getNavigationItems } from './navigation';

describe('getNavigationItems', () => {
  it('keeps administrators out of business navigation by default', () => {
    const hrefs = getNavigationItems(['ADMIN']).map((item) => item.href);

    expect(hrefs).toContain('/admin/users');
    expect(hrefs).not.toContain('/projects');
    expect(hrefs).not.toContain('/reports');
  });

  it('merges navigation capabilities across multiple roles without duplicates', () => {
    const hrefs = getNavigationItems(['APPROVER', 'PROJECT_MANAGER']).map((item) => item.href);

    expect(hrefs).toContain('/approvals');
    expect(hrefs).toContain('/notifications');
    expect(hrefs).toContain('/projects');
    expect(hrefs).toContain('/worklogs');
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('gives employees only the ordinary project-scoped workspace', () => {
    const hrefs = getNavigationItems(['EMPLOYEE']).map((item) => item.href);

    expect(hrefs).toEqual(expect.arrayContaining(['/', '/customers', '/projects', '/worklogs']));
    expect(hrefs).not.toContain('/admin/users');
    expect(hrefs).not.toContain('/reports');
  });

  it('gives an employee access to the notification centre', () => {
    const hrefs = getNavigationItems(['EMPLOYEE']).map((item) => item.href);
    expect(hrefs).toContain('/notifications');
  });

  it('gives an approver access to both approvals and notifications', () => {
    const hrefs = getNavigationItems(['APPROVER']).map((item) => item.href);
    expect(hrefs).toEqual(expect.arrayContaining(['/approvals', '/notifications']));
  });

  it('gives a project manager the managed-projects view', () => {
    const hrefs = getNavigationItems(['PROJECT_MANAGER']).map((item) => item.href);
    expect(hrefs).toContain('/managed-projects');
  });

  it('gives a portfolio director the portfolio overview', () => {
    const hrefs = getNavigationItems(['PORTFOLIO_DIRECTOR']).map((item) => item.href);
    expect(hrefs).toContain('/portfolio-overview');
  });
});
