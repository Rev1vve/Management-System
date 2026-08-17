import { describe, expect, it } from 'vitest';

import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  it('returns a stable API service status', () => {
    const controller = new AppController(new AppService());

    expect(controller.getRoot()).toEqual({
      service: 'project-operations-api',
      status: 'ok',
    });
  });
});
