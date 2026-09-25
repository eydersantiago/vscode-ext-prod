import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  gitInstallHint,
  LatestLinkQueue,
  normalizeRepoParam,
  parseAdaceenUri,
  readRepoFolderMap,
  repoCloneUrl,
  repoFolderName,
  withoutRepoFolder,
  withRepoFolder,
} from '../adaceen-uri';

const BACKEND = 'https://app-adaceen-api-eyder05232002.azurewebsites.net';

describe('parseAdaceenUri', () => {
  it('abrir con codigo y repo', () => {
    assert.deepEqual(parseAdaceenUri({ path: '/abrir', query: 'code=k7p4-m2qx&repo=eydersantiago/proyecto-java' }, BACKEND), {
      action: 'abrir',
      code: 'K7P4-M2QX',
      codeInvalid: false,
      repo: 'eydersantiago/proyecto-java',
      repoInvalid: false,
      ignoredBackend: null,
    });
  });

  it('conectar solo con codigo; rutas desconocidas no hacen nada', () => {
    const request = parseAdaceenUri({ path: '/conectar/', query: 'code=K7P4M2QX' }, BACKEND);
    assert.equal(request.action, 'conectar');
    assert.equal(request.code, 'K7P4-M2QX');
    assert.equal(request.repo, null);
    assert.equal(parseAdaceenUri({ path: '/borrar', query: 'code=K7P4M2QX' }, BACKEND).action, null);
    assert.equal(parseAdaceenUri({ path: '', query: '' }, BACKEND).action, null);
  });

  it('marca el codigo y el repo que no tienen formato', () => {
    const request = parseAdaceenUri({ path: '/abrir', query: 'code=K7P4-M2Q0&repo=..%2F..%2Fetc' }, BACKEND);
    assert.equal(request.code, null);
    assert.equal(request.codeInvalid, true);
    assert.equal(request.repo, null);
    assert.equal(request.repoInvalid, true);
    const vacio = parseAdaceenUri({ path: '/abrir', query: 'code=&repo=' }, BACKEND);
    assert.equal(vacio.codeInvalid, false);
    assert.equal(vacio.repoInvalid, false);
  });

  it('ignora un backend ajeno y acepta el mismo backend escrito distinto', () => {
    const ajeno = parseAdaceenUri({ path: '/abrir', query: 'code=K7P4-M2QX&backend=https://evil.example.com' }, BACKEND);
    assert.equal(ajeno.ignoredBackend, 'https://evil.example.com');
    assert.equal(ajeno.code, 'K7P4-M2QX');
    const mismo = parseAdaceenUri({ path: '/abrir', query: `code=K7P4-M2QX&backend=${BACKEND.toUpperCase()}/` }, BACKEND);
    assert.equal(mismo.ignoredBackend, null);
  });
});

describe('normalizeRepoParam', () => {
  it('acepta owner/repo y la URL de GitHub', () => {
    assert.equal(normalizeRepoParam('eydersantiago/proyecto-java'), 'eydersantiago/proyecto-java');
    assert.equal(normalizeRepoParam(' Owner/Repo.git '), 'Owner/Repo');
    assert.equal(normalizeRepoParam('https://github.com/owner/repo.git'), 'owner/repo');
    assert.equal(normalizeRepoParam('github.com/owner/repo/'), 'owner/repo');
    assert.equal(normalizeRepoParam('owner/.github'), 'owner/.github');
  });

  it('rechaza lo que no es owner/repo de GitHub', () => {
    for (const bad of ['', 'owner', 'a/b/c', '../x', 'owner/..', 'owner/.', '-owner/repo', 'own er/repo', 'owner/re po', 'https://gitlab.com/o/r', `${'o'.repeat(40)}/repo`, null, 7]) {
      assert.equal(normalizeRepoParam(bad), null, String(bad));
    }
  });

  it('url de clonado y carpeta', () => {
    assert.equal(repoCloneUrl('owner/repo'), 'https://github.com/owner/repo.git');
    assert.equal(repoFolderName('owner/repo'), 'repo');
  });
});

describe('mapa repo -> carpeta', () => {
  it('limpia lo que venga de globalState', () => {
    assert.deepEqual(readRepoFolderMap(undefined), {});
    assert.deepEqual(readRepoFolderMap(['x']), {});
    assert.deepEqual(readRepoFolderMap({ 'Owner/Repo': 'file:///Users/ana/repo', malo: 'x', 'o/r': 3, 'a/b': '  ' }), {
      'owner/repo': 'file:///Users/ana/repo',
    });
  });

  it('agrega al final, reemplaza sin distinguir mayusculas y guarda como mucho 50', () => {
    let map = withRepoFolder({}, 'Owner/Repo', 'file:///a');
    map = withRepoFolder(map, 'otro/repo', 'file:///b');
    map = withRepoFolder(map, 'owner/repo', 'file:///c');
    assert.deepEqual(Object.entries(map), [['otro/repo', 'file:///b'], ['owner/repo', 'file:///c']]);
    assert.deepEqual(withoutRepoFolder(map, 'OWNER/repo'), { 'otro/repo': 'file:///b' });
    let big = {};
    for (let index = 0; index < 60; index += 1) {
      big = withRepoFolder(big, `owner/repo${index}`, `file:///${index}`);
    }
    assert.equal(Object.keys(big).length, 50);
    assert.equal(Object.keys(big)[0], 'owner/repo10');
  });
});

describe('gitInstallHint', () => {
  it('ofrece el comando de cada sistema', () => {
    assert.equal(gitInstallHint('darwin').command, 'xcode-select --install');
    assert.match(gitInstallHint('win32').command, /winget/);
    assert.match(gitInstallHint('linux').command, /apt/);
  });
});

describe('LatestLinkQueue', () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it('doble clic con VS Code cerrado: el segundo enlace (codigo vigente) no se descarta', async () => {
    const handled: Array<{ item: string; newerAtEnd: boolean }> = [];
    const gate = deferred();
    const queued: boolean[] = [];
    const queue = new LatestLinkQueue<string>(async (item, hasNewer) => {
      if (item === 'L1') {
        await gate.promise;
      }
      handled.push({ item, newerAtEnd: hasNewer() });
    }, (replaced) => queued.push(replaced));
    const first = queue.push('L1');
    const second = queue.push('L2');
    // push de un enlace en espera termina enseguida; el primero, cuando no queda nada.
    await second;
    assert.equal(queue.hasNewer(), true);
    gate.resolve();
    await first;
    // L1 se entera de que hay uno mas nuevo (no avisa su code_not_found) y L2 se atiende.
    assert.deepEqual(handled, [{ item: 'L1', newerAtEnd: true }, { item: 'L2', newerAtEnd: false }]);
    assert.deepEqual(queued, [false]);
    assert.equal(queue.hasNewer(), false);
  });

  it('varios clics mientras se atiende uno: solo espera el ultimo', async () => {
    const handled: string[] = [];
    const gate = deferred();
    const queued: boolean[] = [];
    const queue = new LatestLinkQueue<string>(async (item) => {
      if (item === 'L1') {
        await gate.promise;
      }
      handled.push(item);
    }, (replaced) => queued.push(replaced));
    const first = queue.push('L1');
    void queue.push('L2');
    void queue.push('L3');
    gate.resolve();
    await first;
    assert.deepEqual(handled, ['L1', 'L3']);
    assert.deepEqual(queued, [false, true]);
  });

  it('un manejador que falla no bloquea los siguientes', async () => {
    const handled: string[] = [];
    const queue = new LatestLinkQueue<string>(async (item) => {
      handled.push(item);
      if (item === 'malo') {
        throw new Error('boom');
      }
    });
    await queue.push('malo');
    await queue.push('bueno');
    assert.deepEqual(handled, ['malo', 'bueno']);
  });
});
