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

interface MockFn<F extends (...args: never[]) => unknown = (...args: unknown[]) => unknown> {
  (...args: Parameters<F>): ReturnType<F>;
  mock: MockState;
  mockImplementation(impl: F): void;
  mockRejectedValue(value: unknown): void;
}

// deno-lint-ignore no-explicit-any
export function mock<F extends (...args: any[]) => any>(impl?: F): MockFn<F> {
  let currentImpl: (...args: unknown[]) => unknown = (impl as (...args: unknown[]) => unknown) ?? (() => undefined);
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

  const mockFn = baseMock as unknown as MockFn<F>;
  mockFn.mock = state;
  mockFn.mockImplementation = (newImpl: F) => {
    currentImpl = newImpl as (...args: unknown[]) => unknown;
  };
  mockFn.mockRejectedValue = (value: unknown) => {
    currentImpl = () => Promise.reject(value);
  };

  return mockFn;
}
