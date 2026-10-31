import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildProgressPill,
  formatReportTime,
  isBuildCommandLine,
  normalizeWorkshopProgressReply,
  pointsSummary,
  progressUrl,
  shouldRefreshAfterWork,
} from '../workshop-progress';
import { WorkshopProgressPoller } from '../workshop-progress-poller';

// Avance del taller en la esquina de la vista «Este archivo» (0.0.38), contra
// GET /api/workshop-progress/me del backend del 30/10/2026.

const NOW = new Date(2026, 9, 30, 15, 0, 0);

/** Como responde el backend: a lo sumo 8 pendientes en el orden del taller, y cuantos son en total. */
function response(patch: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 'en-curso',
    progress: {
      taller: 'banco',
      titulo: 'Sistema bancario',
      percent: 35,
      compiles: true,
      done: 2,
      partial: 3,
      total: 12,
      pending: Array.from({ length: 8 }, (_, index) => ({ id: `p${index + 1}`, hu: index < 2 ? 'HU1' : 'HU2', texto: `Punto ${index + 1}`, partial: index < 3 })),
      pendingCount: 10,
      stale: false,
      receivedAt: new Date(2026, 9, 30, 14, 32).toISOString(),
      lastChangeAt: new Date(2026, 9, 30, 14, 20).toISOString(),
      matchedBy: 'repo',
      ...patch,
    },
  };
}

describe('avance del taller (0.0.38)', () => {
  it('lee la respuesta del contrato y descarta lo que no lo cumple', () => {
    const reply = normalizeWorkshopProgressReply(response());
    assert.equal(reply?.status, 'en-curso');
    const progress = reply?.status === 'en-curso' ? reply.progress : null;
    assert.equal(progress?.percent, 35);
    assert.equal(progress?.pending.length, 8);
    assert.equal(progress?.pendingCount, 10);
    assert.equal(progress?.pending[0].partial, true);
    assert.equal(progress?.matchedBy, 'repo');
    for (const status of ['sin-editor', 'sin-taller', 'sin-carpeta'] as const) {
      assert.deepEqual(normalizeWorkshopProgressReply({ ok: true, status, progress: null }), { status, progress: null });
    }
    assert.equal(normalizeWorkshopProgressReply({ ok: true, status: 'en-curso', progress: null }), null, 'en curso sin avance no vale');
    assert.equal(normalizeWorkshopProgressReply({ ok: true, status: 'otro', progress: null }), null);
    assert.equal(normalizeWorkshopProgressReply({ ok: true, progress: response().progress }), null, 'sin status (la ruta vieja) no vale');
    assert.equal(normalizeWorkshopProgressReply({ ok: false, error: 'x' }), null);
    assert.equal(normalizeWorkshopProgressReply('<html>'), null);
    assert.equal(normalizeWorkshopProgressReply(null), null, 'sin sesion no hay respuesta');
    const capped = normalizeWorkshopProgressReply(response({ percent: 140.4, compiles: 'si', pendingCount: 2 }));
    const cappedProgress = capped?.status === 'en-curso' ? capped.progress : null;
    assert.equal(cappedProgress?.percent, 100);
    assert.equal(cappedProgress?.compiles, null);
    assert.equal(cappedProgress?.pendingCount, 8, 'nunca menos que los de la lista');
  });

  it('la pastilla: porcentaje, cuentas sin contradecirse, lo que falta (a medias marcado) y «y N más» de pendingCount', () => {
    const pill = buildProgressPill(normalizeWorkshopProgressReply(response()), NOW);
    assert.equal(pill?.text, '35 %');
    assert.equal(pill?.level, 'low');
    assert.equal(pill?.stale, false);
    const title = pill?.title || '';
    assert.match(title, /^Avance del taller «Sistema bancario»: 35 % · 2 hechos y 3 a medias de 12 puntos/);
    assert.match(title, /Tu proyecto compila\./);
    assert.match(title, /• HU1: Punto 1 \(a medias\)/);
    assert.match(title, /• HU2: Punto 8$/m, 'sin «a medias» lo que falta del todo');
    assert.match(title, /… y 2 puntos más/, 'pendingCount 10 menos los 8 de la lista');
    assert.match(title, /Medido hoy 14:32\./);
  });

  it('cuentas en palabras', () => {
    assert.equal(pointsSummary({ done: 2, partial: 3, total: 10 }), '2 hechos y 3 a medias de 10 puntos');
    assert.equal(pointsSummary({ done: 1, partial: 0, total: 1 }), '1 hecho de 1 punto');
    assert.equal(pointsSummary({ done: 0, partial: 0, total: 0 }), '');
  });

  it('desactualizado, sin compilar y completo', () => {
    const stale = buildProgressPill(normalizeWorkshopProgressReply(response({ stale: true, compiles: false, percent: 60 })), NOW);
    assert.equal(stale?.stale, true);
    assert.equal(stale?.level, 'mid');
    assert.match(stale?.title || '', /desactualizado/);
    assert.match(stale?.title || '', /no compila/);
    const full = buildProgressPill(normalizeWorkshopProgressReply(response({ percent: 100, pending: [], pendingCount: 0, done: 12, partial: 0 })), NOW);
    assert.equal(full?.level, 'high');
    assert.match(full?.title || '', /Todos los puntos están hechos/);
    assert.equal(buildProgressPill(null), null);
  });

  it('sin avance todavia: pastilla apagada que dice que falta, o nada sin taller', () => {
    const editor = buildProgressPill({ status: 'sin-editor', progress: null });
    assert.equal(editor?.level, 'muted');
    assert.equal(editor?.text, '— %');
    assert.match(editor?.title || '', /GitHub/);
    const folder = buildProgressPill({ status: 'sin-carpeta', progress: null });
    assert.equal(folder?.level, 'muted');
    assert.match(folder?.title || '', /carpeta del taller/);
    assert.equal(buildProgressPill({ status: 'sin-taller', progress: null }), null);
  });

  it('hora del informe en palabras', () => {
    assert.equal(formatReportTime(new Date(2026, 9, 29, 9, 5).toISOString(), NOW), 'ayer 09:05');
    assert.equal(formatReportTime(new Date(2026, 9, 27, 18, 40).toISOString(), NOW), '27/10 18:40');
    assert.equal(formatReportTime('no es fecha', NOW), '');
  });

  it('la URL lleva el repositorio (repoFullName) solo si tiene forma owner/name', () => {
    assert.equal(progressUrl('https://api.x/', 'eyder/banco-taller'), 'https://api.x/api/workshop-progress/me?repoFullName=eyder%2Fbanco-taller');
    assert.equal(progressUrl('https://api.x', '../../etc'), 'https://api.x/api/workshop-progress/me');
    assert.equal(progressUrl('https://api.x', undefined), 'https://api.x/api/workshop-progress/me');
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
  function setup(fetchProgress: () => Promise<unknown>) {
    let now = 1_000_000;
    const changes: Array<number | string | null> = [];
    const timers: Array<() => void> = [];
    let cleared = 0;
    const poller = new WorkshopProgressPoller({
      fetchProgress,
      onChange: (reply) => changes.push(reply ? (reply.status === 'en-curso' ? reply.progress.percent : reply.status) : null),
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
    assert.equal(poller.reply?.status === 'en-curso' && poller.reply.progress.percent, 80);
  });

  it('sin sesion no hay avance', async () => {
    const { poller, changes } = setup(async () => null);
    await poller.refresh();
    assert.deepEqual(changes, [], 'ya estaba escondida: no avisa');
    assert.equal(poller.reply, null);
  });
});
