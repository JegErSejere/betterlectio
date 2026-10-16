import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  sanitizeLectioUploadFilename,
  uploadDocumentToLectio,
} from './lectio-file-upload';

describe('sanitizeLectioUploadFilename', () => {
  it('replaces characters Lectio rejects while preserving the extension', () => {
    assert.equal(
      sanitizeLectioUploadFilename('Analytical essay "Words"?.docx'),
      'Analytical essay _Words__.docx',
    );
  });

  it('removes trailing dots and spaces', () => {
    assert.equal(sanitizeLectioUploadFilename('report. .pdf'), 'report.pdf');
  });

  it('provides a safe fallback name', () => {
    assert.equal(sanitizeLectioUploadFilename('???'), '___');
  });

  it('limits long names without dropping the extension', () => {
    const result = sanitizeLectioUploadFilename(`${'a'.repeat(250)}.docx`);
    assert.equal(result.length, 180);
    assert.ok(result.endsWith('.docx'));
  });

  it('uploads with the sanitized multipart filename', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'window', {
      value: { location: { origin: 'https://www.lectio.dk' } },
      configurable: true,
    });
    let uploadedName = '';
    globalThis.fetch = (async (_input, init) => {
      const uploaded = (init?.body as FormData).get('file') as File;
      uploadedName = uploaded.name;
      return new Response(JSON.stringify({ serializedId: 'document-123' }), { status: 200 });
    }) as typeof fetch;

    try {
      const result = await uploadDocumentToLectio(
        new File(['document'], 'Essay "final"?.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
        '21',
      );
      assert.equal(result.serializedId, 'document-123');
      assert.equal(uploadedName, 'Essay _final__.docx');
      assert.equal(result.filenameWasSanitized, true);
    } finally {
      globalThis.fetch = originalFetch;
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });

  it('surfaces Lectio upload status failures', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'window', {
      value: { location: { origin: 'https://www.lectio.dk' } },
      configurable: true,
    });
    globalThis.fetch = (async () => new Response('Bad Request', { status: 400 })) as typeof fetch;

    try {
      await assert.rejects(
        uploadDocumentToLectio(new File(['x'], 'valid.pdf'), '21'),
        /HTTP 400/,
      );
    } finally {
      globalThis.fetch = originalFetch;
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
  });
});
