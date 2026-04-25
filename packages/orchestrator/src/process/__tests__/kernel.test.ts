import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ProcessKernel } from '../kernel.js';

describe('ProcessKernel', () => {
  it('createPipe returns connected read/write ends', async () => {
    const kernel = new ProcessKernel();
    // Allocate a process so it has an fd table to attach pipe ends to.
    const pid = kernel.allocPid();
    const { readFd, writeFd } = kernel.createPipe(pid);
    expect(readFd).toBeGreaterThanOrEqual(3);
    expect(writeFd).toBeGreaterThanOrEqual(3);
    expect(writeFd).toBe(readFd + 1);
    kernel.dispose();
  });

  it('closeFd closes pipe ends', () => {
    const kernel = new ProcessKernel();
    const pid = kernel.allocPid();
    const { readFd, writeFd } = kernel.createPipe(pid);
    kernel.closeFd(pid, writeFd);
    kernel.closeFd(pid, readFd);
    kernel.dispose();
  });

  it('getFdTarget returns the target for a given fd', () => {
    const kernel = new ProcessKernel();
    const pid = kernel.allocPid();
    const { readFd } = kernel.createPipe(pid);
    const target = kernel.getFdTarget(pid, readFd);
    expect(target).not.toBeNull();
    expect(target!.type).toBe('pipe_read');
    kernel.dispose();
  });
});
