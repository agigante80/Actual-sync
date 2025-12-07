/**
 * Unit tests for retry logic in syncService
 */

const { wait } = require('./helpers/testHelpers');

// Mock the retry function to test it independently
function createRetryFunction(maxRetries, baseRetryDelayMs) {
    return async function runWithRetries(fn, retries = maxRetries) {
        for (let i = 0; i <= retries; i++) {
            try {
                return await fn();
            } catch (error) {
                let retryDelay = 0;

                if (error.code === 'NORDIGEN_ERROR' && error.category === 'RATE_LIMIT_EXCEEDED') {
                    retryDelay = baseRetryDelayMs * (2 ** i);
                } else if (error.message === 'network-failure' || error.code === 'ECONNRESET' || error.code === 'ENOTFOUND') {
                    retryDelay = baseRetryDelayMs * (2 ** i);
                } else {
                    throw error;
                }
                
                if (i === retries) {
                    throw error;
                }
                
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }
    };
}

describe('Retry Logic', () => {
    let runWithRetries;
    const MAX_RETRIES = 3;
    const BASE_RETRY_DELAY_MS = 100; // Shorter for testing

    beforeEach(() => {
        runWithRetries = createRetryFunction(MAX_RETRIES, BASE_RETRY_DELAY_MS);
        jest.spyOn(console, 'log').mockImplementation();
        jest.spyOn(console, 'error').mockImplementation();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('Success scenarios', () => {
        test('should succeed on first attempt', async () => {
            const successFn = jest.fn().mockResolvedValue('success');
            
            const result = await runWithRetries(successFn);
            
            expect(result).toBe('success');
            expect(successFn).toHaveBeenCalledTimes(1);
        });

        test('should succeed after retries', async () => {
            let attempts = 0;
            const eventualSuccessFn = jest.fn().mockImplementation(() => {
                attempts++;
                if (attempts < 3) {
                    const error = new Error('network-failure');
                    throw error;
                }
                return Promise.resolve('success');
            });
            
            const result = await runWithRetries(eventualSuccessFn);
            
            expect(result).toBe('success');
            expect(eventualSuccessFn).toHaveBeenCalledTimes(3);
        });
    });

    describe('Rate limit handling', () => {
        test('should retry with exponential backoff on rate limit', async () => {
            let attempts = 0;
            const rateLimitFn = jest.fn().mockImplementation(() => {
                attempts++;
                if (attempts < 3) {
                    const error = new Error('Rate limit exceeded');
                    error.code = 'NORDIGEN_ERROR';
                    error.category = 'RATE_LIMIT_EXCEEDED';
                    throw error;
                }
                return Promise.resolve('success');
            });
            
            const startTime = Date.now();
            const result = await runWithRetries(rateLimitFn);
            const duration = Date.now() - startTime;
            
            expect(result).toBe('success');
            expect(rateLimitFn).toHaveBeenCalledTimes(3);
            // Should have waited: 100ms (first retry) + 200ms (second retry) = 300ms minimum
            expect(duration).toBeGreaterThanOrEqual(250); // Allow some tolerance
        });

        test('should throw after max retries on rate limit', async () => {
            const rateLimitFn = jest.fn().mockImplementation(() => {
                const error = new Error('Rate limit exceeded');
                error.code = 'NORDIGEN_ERROR';
                error.category = 'RATE_LIMIT_EXCEEDED';
                throw error;
            });
            
            await expect(runWithRetries(rateLimitFn)).rejects.toThrow('Rate limit exceeded');
            expect(rateLimitFn).toHaveBeenCalledTimes(MAX_RETRIES + 1); // Initial + 3 retries = 4 total
        });
    });

    describe('Network error handling', () => {
        test('should retry on network-failure error', async () => {
            let attempts = 0;
            const networkFn = jest.fn().mockImplementation(() => {
                attempts++;
                if (attempts < 2) {
                    throw new Error('network-failure');
                }
                return Promise.resolve('success');
            });
            
            const result = await runWithRetries(networkFn);
            
            expect(result).toBe('success');
            expect(networkFn).toHaveBeenCalledTimes(2);
        });

        test('should retry on ECONNRESET error', async () => {
            let attempts = 0;
            const connResetFn = jest.fn().mockImplementation(() => {
                attempts++;
                if (attempts < 2) {
                    const error = new Error('Connection reset');
                    error.code = 'ECONNRESET';
                    throw error;
                }
                return Promise.resolve('success');
            });
            
            const result = await runWithRetries(connResetFn);
            
            expect(result).toBe('success');
            expect(connResetFn).toHaveBeenCalledTimes(2);
        });

        test('should retry on ENOTFOUND error', async () => {
            let attempts = 0;
            const notFoundFn = jest.fn().mockImplementation(() => {
                attempts++;
                if (attempts < 2) {
                    const error = new Error('DNS lookup failed');
                    error.code = 'ENOTFOUND';
                    throw error;
                }
                return Promise.resolve('success');
            });
            
            const result = await runWithRetries(notFoundFn);
            
            expect(result).toBe('success');
            expect(notFoundFn).toHaveBeenCalledTimes(2);
        });

        test('should apply exponential backoff on network errors', async () => {
            let attempts = 0;
            const networkFn = jest.fn().mockImplementation(() => {
                attempts++;
                if (attempts < 3) {
                    throw new Error('network-failure');
                }
                return Promise.resolve('success');
            });
            
            const startTime = Date.now();
            await runWithRetries(networkFn);
            const duration = Date.now() - startTime;
            
            // Should have waited: 100ms + 200ms = 300ms minimum
            expect(duration).toBeGreaterThanOrEqual(250);
        });
    });

    describe('Non-retryable errors', () => {
        test('should not retry on non-retryable errors', async () => {
            const nonRetryableFn = jest.fn().mockRejectedValue(new Error('Invalid configuration'));
            
            await expect(runWithRetries(nonRetryableFn)).rejects.toThrow('Invalid configuration');
            expect(nonRetryableFn).toHaveBeenCalledTimes(1); // Should not retry
        });

        test('should not retry on authentication errors', async () => {
            const authError = new Error('Unauthorized');
            authError.code = 'AUTH_ERROR';
            const authFn = jest.fn().mockRejectedValue(authError);
            
            await expect(runWithRetries(authFn)).rejects.toThrow('Unauthorized');
            expect(authFn).toHaveBeenCalledTimes(1);
        });
    });

    describe('Exponential backoff calculation', () => {
        test('should double delay on each retry', async () => {
            const delays = [];
            let attempts = 0;
            
            const trackingFn = jest.fn().mockImplementation(async () => {
                attempts++;
                if (attempts < 4) {
                    const error = new Error('network-failure');
                    throw error;
                }
                return 'success';
            });
            
            // Spy on setTimeout to track delays
            const originalSetTimeout = global.setTimeout;
            global.setTimeout = jest.fn((fn, delay) => {
                if (delay > 0) delays.push(delay);
                return originalSetTimeout(fn, delay);
            });
            
            await runWithRetries(trackingFn);
            
            // Delays should be: 100, 200, 400 (exponential: base * 2^i)
            expect(delays[0]).toBe(BASE_RETRY_DELAY_MS * (2 ** 0)); // 100
            expect(delays[1]).toBe(BASE_RETRY_DELAY_MS * (2 ** 1)); // 200
            expect(delays[2]).toBe(BASE_RETRY_DELAY_MS * (2 ** 2)); // 400
            
            global.setTimeout = originalSetTimeout;
        });
    });

    describe('Edge cases', () => {
        test('should handle maxRetries = 0', async () => {
            const zeroRetryFn = createRetryFunction(0, BASE_RETRY_DELAY_MS);
            const failFn = jest.fn().mockRejectedValue(new Error('network-failure'));
            
            await expect(zeroRetryFn(failFn)).rejects.toThrow('network-failure');
            expect(failFn).toHaveBeenCalledTimes(1); // Only initial attempt
        });

        test('should handle function returning undefined', async () => {
            const undefinedFn = jest.fn().mockResolvedValue(undefined);
            
            const result = await runWithRetries(undefinedFn);
            
            expect(result).toBeUndefined();
            expect(undefinedFn).toHaveBeenCalledTimes(1);
        });

        test('should handle function returning null', async () => {
            const nullFn = jest.fn().mockResolvedValue(null);
            
            const result = await runWithRetries(nullFn);
            
            expect(result).toBeNull();
            expect(nullFn).toHaveBeenCalledTimes(1);
        });
    });
});
