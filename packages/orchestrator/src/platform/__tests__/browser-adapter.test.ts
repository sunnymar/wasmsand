import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { BrowserAdapter } from '../browser-adapter.js';

describe('BrowserAdapter', () => {
  it('includes document tools in the browser tool registry', async () => {
    const adapter = new BrowserAdapter();
    const tools = await adapter.scanTools('/wasm');

    expect(tools.get('pdfinfo')).toBe('/wasm/pdfinfo.wasm');
    expect(tools.get('pdfunite')).toBe('/wasm/pdfunite.wasm');
    expect(tools.get('pdfseparate')).toBe('/wasm/pdfseparate.wasm');
    expect(tools.get('xlsx2csv')).toBe('/wasm/xlsx2csv.wasm');
    expect(tools.get('csv2xlsx')).toBe('/wasm/csv2xlsx.wasm');
  });
});
