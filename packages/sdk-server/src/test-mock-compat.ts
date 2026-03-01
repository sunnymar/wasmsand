/**
 * Bun-compatible mock wrapper around @std/expect's fn().
 * Provides .mock.calls, .mock.results, .mockImplementation(), .mockRejectedValue().
 */
import { fn } from '@std/expect';

interface MockResult {
  type: 'return' | 'throw';
  value: unknown;
}

interface MockState {
  calls: unknown[][];
  results: MockResult[];
}

interface MockFn {
  (...args: unknown[]): unknown;
  mock: MockState;
  mockImplementation(impl: (...args: unknown[]) => unknown): void;
  mockRejectedValue(value: unknown): void;
}

export function mock(impl?: (...args: unknown[]) => unknown): MockFn {
  let currentImpl = impl ?? (() => undefined);
  const state: MockState = { calls: [], results: [] };

  // Create the fn()-based mock so expect().toHaveBeenCalled() etc. work
  const baseMock = fn((...args: unknown[]) => {
    state.calls.push(args);
    try {
      const result = currentImpl(...args);
      if (result instanceof Promise) {
        const wrappedPromise = result.then(
          (value) => {
            state.results.push({ type: 'return', value });
            return value;
          },
          (err) => {
            state.results.push({ type: 'throw', value: err });
            throw err;
          },
        );
        return wrappedPromise;
      }
      state.results.push({ type: 'return', value: result });
      return result;
    } catch (err) {
      state.results.push({ type: 'throw', value: err });
      throw err;
    }
  });

  const mockFn = baseMock as unknown as MockFn;
  mockFn.mock = state;
  mockFn.mockImplementation = (newImpl: (...args: unknown[]) => unknown) => {
    currentImpl = newImpl;
  };
  mockFn.mockRejectedValue = (value: unknown) => {
    currentImpl = () => Promise.reject(value);
  };

  return mockFn;
}
