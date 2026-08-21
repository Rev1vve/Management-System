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
});
