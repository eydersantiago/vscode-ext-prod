import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildProgressPill,
  formatReportTime,
  normalizeWorkshopProgress,
  progressUrl,
  isBuildCommandLine,
  shouldRefreshAfterWork,
} from '../workshop-progress';
import { WorkshopProgressPoller } from '../workshop-progress-poller';

// Avance del taller en la esquina de la vista «Este archivo» (0.0.38).

const NOW = new Date(2026, 9, 30, 15, 0, 0);

function response(patch: Record<string, unknown> = {}) {
  return {
    ok: true,
    progress: {
      taller: 'banco',
      titulo: 'Sistema bancario',
      percent: 35,
      compiles: true,
      done: 4,
      total: 11,
      missing: Array.from({ length: 10 }, (_, index) => ({ id: `p${index + 1}`, hu: index < 2 ? 'HU1' : 'HU2', texto: `Punto ${index + 1}` })),
      stale: false,
      receivedAt: new Date(2026, 9, 30, 14, 32).toISOString(),
      lastChangeAt: new Date(2026, 9, 30, 14, 20).toISOString(),
      ...patch,
    },
  };
}

describe('avance del taller (0.0.38)', () => {
  it('lee la respuesta del contrato y descarta lo que no lo cumple', () => {
    const progress = normalizeWorkshopProgress(response());
    assert.equal(progress?.percent, 35);
    assert.equal(progress?.missing.length, 10);
    assert.equal(progress?.compiles, true);
    assert.equal(normalizeWorkshopProgress({ ok: true, progress: null }), null, 'sin informe todavia');
    assert.equal(normalizeWorkshopProgress({ ok: false, error: 'x' }), null);
    assert.equal(normalizeWorkshopProgress('<html>'), null);
    assert.equal(normalizeWorkshopProgress({ ok: true, progress: { percent: 'mucho' } }), null);
    assert.equal(normalizeWorkshopProgress(response({ percent: 140.4 }))?.percent, 100);
    assert.equal(normalizeWorkshopProgress(response({ compiles: 'si' }))?.compiles, null);
  });

  it('la pastilla: el porcentaje, hasta 8 puntos que faltan y la hora del informe', () => {
    const pill = buildProgressPill(normalizeWorkshopProgress(response()), NOW);
    assert.equal(pill?.text, '35 %');
    assert.equal(pill?.level, 'low');
    assert.equal(pill?.stale, false);
    const title = pill?.title || '';
    assert.match(title, /^Avance del taller «Sistema bancario»: 35 % \(4 de 11 puntos\)/);
    assert.match(title, /Tu proyecto compila\./);
    assert.match(title, /• HU1: Punto 1/);
    assert.match(title, /• HU2: Punto 8/);
    assert.doesNotMatch(title, /Punto 9/, 'a lo sumo 8');
    assert.match(title, /… y 2 puntos más/);
    assert.match(title, /Medido hoy 14:32\./);
  });

  it('desactualizado, sin compilar y completo', () => {
    const stale = buildProgressPill(normalizeWorkshopProgress(response({ stale: true, compiles: false, percent: 60 })), NOW);
    assert.equal(stale?.stale, true);
    assert.equal(stale?.level, 'mid');
    assert.match(stale?.title || '', /desactualizado/);
    assert.match(stale?.title || '', /no compila/);
    const full = buildProgressPill(normalizeWorkshopProgress(response({ percent: 100, missing: [], done: 11 })), NOW);
    assert.equal(full?.level, 'high');
    assert.match(full?.title || '', /Todos los puntos están hechos/);
    assert.equal(buildProgressPill(null), null);
  });

  it('hora del informe en palabras', () => {
    assert.equal(formatReportTime(new Date(2026, 9, 29, 9, 5).toISOString(), NOW), 'ayer 09:05');
    assert.equal(formatReportTime(new Date(2026, 9, 27, 18, 40).toISOString(), NOW), '27/10 18:40');
    assert.equal(formatReportTime('no es fecha', NOW), '');
  });

  it('la URL lleva el repositorio (repoFullName, como las demas rutas) solo si tiene forma owner/name', () => {
    assert.equal(progressUrl('https://api.x/', 'eyder/banco-taller'), 'https://api.x/api/workspaces/my-progress?repoFullName=eyder%2Fbanco-taller');
    assert.equal(progressUrl('https://api.x', '../../etc'), 'https://api.x/api/workspaces/my-progress');
    assert.equal(progressUrl('https://api.x', undefined), 'https://api.x/api/workspaces/my-progress');
  });

  it('despues de guardar o compilar, a lo sumo una consulta cada 2 minutos', () => {
    assert.equal(shouldRefreshAfterWork(0, 1000), true);
    assert.equal(shouldRefreshAfterWork(1000, 1000 + 60_000), false);
    assert.equal(shouldRefreshAfterWork(1000, 1000 + 120_000), true);
  });

  it('que ordenes de la terminal cuentan como compilar o ejecutar el taller', () => {
    for (const line of ['make', 'cd build && make -j4', 'g++ -o banco src/*.cpp', '/usr/bin/g++-12 main.cpp', 'cmake --build build', 'python3 main.py', 'javac *.java', './banco', 'sudo make install', 'CXX=clang++ make', 'mvn test', 'dotnet run']) {
      assert.equal(isBuildCommandLine(line), true, line);
    }
    for (const line of ['ls -la', 'git status', 'cat Makefile', 'echo make', 'cd src', '', 'code .']) {
      assert.equal(isBuildCommandLine(line), false, line);
    }
  });
});

describe('cuando se pide el avance (0.0.38)', () => {
  function setup(fetchProgress: () => Promise<unknown | null>) {
    let now = 1_000_000;
    const changes: Array<number | null> = [];
    const timers: Array<() => void> = [];
    let cleared = 0;
    const poller = new WorkshopProgressPoller({
      fetchProgress,
      onChange: (progress) => changes.push(progress ? progress.percent : null),
      now: () => now,
      setInterval: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearInterval: () => {
        cleared += 1;
      },
    });
    return { poller, changes, timers, advance: (ms: number) => { now += ms; }, cleared: () => cleared };
  }

  it('al mostrarse pide y programa cada 5 minutos; al ocultarse para', async () => {
    let calls = 0;
    const { poller, changes, timers, cleared } = setup(async () => {
      calls += 1;
      return response();
    });
    poller.setVisible(true);
    await poller.refresh();
    assert.equal(calls, 1, 'una sola consulta aunque se pida dos veces a la vez');
    assert.deepEqual(changes, [35]);
    assert.equal(timers.length, 1);
    poller.setVisible(true);
    assert.equal(timers.length, 1, 'no programa dos veces');
    poller.setVisible(false);
    assert.equal(cleared(), 1);
    poller.setVisible(true);
    await poller.refresh();
    assert.equal(calls, 1, 'al activar y al mostrarse la vista enseguida: una sola consulta');
  });

  it('guardar pide a lo sumo una vez cada 2 minutos', async () => {
    let calls = 0;
    const { poller, advance } = setup(async () => {
      calls += 1;
      return response();
    });
    await poller.refresh();
    poller.refreshAfterWork();
    assert.equal(calls, 1);
    advance(121_000);
    poller.refreshAfterWork();
    await poller.refresh();
    assert.equal(calls, 2);
  });

  it('un backend anterior (404) esconde la pastilla sin avisar y no insiste; otra sesion si pregunta', async () => {
    let calls = 0;
    let fail: number | null = null;
    const { poller, changes, advance } = setup(async () => {
      calls += 1;
      if (fail) {
        throw Object.assign(new Error('Not Found'), { status: fail });
      }
      return response();
    });
    await poller.refresh();
    fail = 404;
    advance(130_000);
    await poller.refresh();
    assert.deepEqual(changes, [35, null]);
    advance(130_000);
    await poller.refresh();
    assert.equal(calls, 2, 'tras un 404 espera 30 minutos');
    await poller.refetchForNewSession();
    assert.equal(calls, 3, 'con otra sesion pregunta igual');
    fail = null;
    advance(31 * 60_000);
    await poller.refresh();
    assert.deepEqual(changes, [35, null, 35]);
  });

  it('al cambiar de sesion se esconde enseguida y lo que llega de la sesion anterior se descarta', async () => {
    const pending: Array<(value: unknown) => void> = [];
    const { poller, changes, advance } = setup(() => new Promise((resolve) => pending.push(resolve)));
    const first = poller.refresh();
    pending[0](response({ percent: 35 }));
    await first;
    assert.deepEqual(changes, [35]);

    // Consulta en curso con la sesion de Ana; Beto inicia sesion en el mismo equipo mientras tanto.
    advance(30_000);
    const anaFetch = poller.refresh();
    const betoFetch = poller.refetchForNewSession();
    assert.equal(pending.length, 3, 'la consulta de la sesion nueva sale aunque haya otra en curso');
    assert.deepEqual(changes, [35, null], 'lo de Ana se esconde enseguida');
    pending[2](response({ percent: 80 }));
    await betoFetch;
    pending[1](response({ percent: 35 }));
    await anaFetch;
    assert.deepEqual(changes, [35, null, 80], 'la respuesta de la sesion de Ana se ignora aunque llegue despues');
    assert.equal(poller.progress?.percent, 80);
  });

  it('sin sesion no hay avance', async () => {
    const { poller, changes } = setup(async () => null);
    await poller.refresh();
    assert.deepEqual(changes, [], 'ya estaba escondida: no avisa');
    assert.equal(poller.progress, null);
  });
});
