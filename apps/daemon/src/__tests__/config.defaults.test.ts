import { describe, it, expect } from 'vitest';
import { loadConfig } from '../config';

describe('Config Defaults', () => {
    it('should have INTERACTIVE as the default run mode', () => {
        const config = loadConfig();
        expect(config.orchestration?.defaultRunMode).toBe('INTERACTIVE');
    });
});
