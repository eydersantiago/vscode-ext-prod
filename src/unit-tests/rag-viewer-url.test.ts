import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { isRagViewerPath, ragViewerUrl } from '../rag-viewer-url';

const BACKEND = 'https://app-adaceen-api-eyder05232002.azurewebsites.net';
const SESSION = '11111111-2222-4333-8444-555555555555';

describe('ragViewerUrl', () => {
  it('el visor nunca lleva la sesion, aunque venga en el enlace del backend', () => {
    const url = ragViewerUrl(`${BACKEND}/api/rag/sources/src-1/view?chunkId=c1&page=3&sessionId=${SESSION}`, BACKEND);
    assert.equal(url, `${BACKEND}/api/rag/sources/src-1/view?chunkId=c1&page=3`);
    assert.doesNotMatch(url, new RegExp(SESSION));
  });

  it('resuelve enlaces relativos contra el backend y no agrega nada', () => {
    assert.equal(
      ragViewerUrl('/api/rag/sources/src-2/view?page=1', BACKEND),
      `${BACKEND}/api/rag/sources/src-2/view?page=1`,
    );
    assert.equal(ragViewerUrl('/api/rag/sources/src-2/view', BACKEND), `${BACKEND}/api/rag/sources/src-2/view`);
  });

  it('otros enlaces se devuelven tal cual', () => {
    const drive = 'https://drive.google.com/file/d/abc/view?usp=sharing&sessionId=x';
    assert.equal(ragViewerUrl(drive, BACKEND), drive);
    assert.equal(ragViewerUrl('', BACKEND), '');
    assert.equal(ragViewerUrl('no es url', ''), 'no es url');
  });

  it('reconoce la ruta del visor', () => {
    assert.equal(isRagViewerPath('/api/rag/sources/abc/view'), true);
    assert.equal(isRagViewerPath('/api/rag/sources/abc'), false);
  });
});
