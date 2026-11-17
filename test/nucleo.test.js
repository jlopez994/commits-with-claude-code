'use strict';
// Prueba del troceado y de la aplicacion del plan en un repo temporal, sin llamar a Claude: node test/nucleo.test.js
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const n = require('../nucleo');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-commits-'));
const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-commits-vacio-'));
const gitEn = dir => (...args) => cp.execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const git = gitEn(raiz);
const escribir = (f, contenido) => fs.writeFileSync(path.join(raiz, f), contenido);
const iniciar = g => {
  g('init', '-q');
  g('config', 'user.name', 'test');
  g('config', 'user.email', 'test@example.com');
  g('config', 'core.autocrlf', 'false');
};

(async () => {
  iniciar(git);
  escribir('a.txt', Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  escribir('crlf.txt', 'one\r\ntwo\r\nthree\r\n');
  escribir('c.txt', 'to delete\n');
  escribir('com"illa.txt', 'old\n');
  git('add', '-A');
  git('commit', '-qm', 'initial');

  escribir('a.txt', fs.readFileSync(path.join(raiz, 'a.txt'), 'utf8').replace('line 2\n', 'line 2 camión\n').replace('line 35\n', 'line 35 changed\n'));
  escribir('crlf.txt', 'one\r\nTWO\r\nthree\r\n');
  escribir('b.txt', 'new\n');
  fs.unlinkSync(path.join(raiz, 'c.txt'));
  escribir('com"illa.txt', 'new\n');

  const enteros = await n.leerUnidades(raiz, [], true);
  assert.deepStrictEqual(enteros.map(u => [u.ruta, u.tipo]).sort(),
    [['a.txt', 'fichero'], ['b.txt', 'fichero'], ['c.txt', 'fichero'], ['com"illa.txt', 'fichero'], ['crlf.txt', 'fichero']],
    'por fichero: una unidad por fichero, con la ruta entrecomillada por git ya descomillada');

  const unidades = await n.leerUnidades(raiz, []);
  const porId = {};
  unidades.forEach(u => { porId[u.id] = u; });
  const id = (ruta, orden) => unidades.find(u => u.ruta === ruta && (orden === undefined || u.orden === orden)).id;
  assert.strictEqual(unidades.filter(u => u.ruta === 'a.txt').length, 2, 'a.txt debe dar dos hunks');
  assert.strictEqual(porId[id('c.txt')].estado, 'deleted');
  assert.strictEqual(porId[id('b.txt')].estado, 'untracked');

  // el segundo hunk va antes que el primero para obligar a git apply a desplazarse
  const plan = n.interpretarPlan('basura antes ' + JSON.stringify({
    warning: '',
    commits: [
      { message: '"second hunk and new file"', why: 'x', units: [id('a.txt', 1), id('b.txt'), 'U99'] },
      { message: 'first hunk and crlf', units: [id('a.txt', 0), id('crlf.txt'), id('a.txt', 1), id('com"illa.txt')] },
    ],
    skip: [],
  }) + ' basura despues', unidades);
  assert.strictEqual(plan.commits[0].mensaje, 'second hunk and new file');
  assert.deepStrictEqual(plan.commits[1].unidades, [id('a.txt', 0), id('crlf.txt'), id('com"illa.txt')], 'una unidad repetida se queda en el primer commit');
  assert.deepStrictEqual(plan.sinCommit.map(s => s.unidad), [id('c.txt')], 'lo no asignado queda fuera');

  const resultado = await n.aplicarPlan(raiz, plan.commits, porId, () => undefined);

  assert.deepStrictEqual(git('log', '--format=%s').split('\n'), ['first hunk and crlf', 'second hunk and new file', 'initial']);
  assert.deepStrictEqual(git('show', '--name-only', '--format=', 'HEAD~1').split('\n').sort(), ['a.txt', 'b.txt']);
  assert.ok(git('show', 'HEAD:a.txt').includes('line 2 camión'), 'se conservan los acentos');
  assert.strictEqual(cp.execFileSync('git', ['show', 'HEAD:crlf.txt'], { cwd: raiz }).toString('latin1'), 'one\r\nTWO\r\nthree\r\n', 'se conserva CRLF');
  assert.strictEqual(git('status', '--short'), 'D c.txt', 'solo queda el borrado sin commitear');
  assert.strictEqual(n.limpiarMensaje('```\nfix: thing\n```'), 'fix: thing');

  await n.deshacer(raiz, resultado);
  assert.strictEqual(git('log', '--format=%s'), 'initial', 'deshacer vuelve al HEAD inicial');
  assert.deepStrictEqual(git('-c', 'core.quotePath=false', 'diff', '--cached', '--name-only').split('\n').sort(),
    ['"com\\"illa.txt"', 'a.txt', 'b.txt', 'crlf.txt'], 'y deja los cambios en stage');
  await assert.rejects(n.deshacer(raiz, resultado), /HEAD/, 'si HEAD se ha movido no deshace');

  // repo sin ningun commit: el primero se crea y deshacer vuelve a dejarlo sin commits
  const gv = gitEn(vacio);
  iniciar(gv);
  fs.writeFileSync(path.join(vacio, 'x.txt'), 'x\n');
  const uv = await n.leerUnidades(vacio, [], true);
  const pv = {};
  uv.forEach(u => { pv[u.id] = u; });
  const rv = await n.aplicarPlan(vacio, [{ mensaje: 'first', unidades: uv.map(u => u.id) }], pv, () => undefined);
  assert.strictEqual(gv('log', '--format=%s'), 'first');
  await n.deshacer(vacio, rv);
  assert.throws(() => gv('rev-parse', '--verify', '-q', 'HEAD'), 'deshacer el primer commit deja el repo sin commits');
  assert.strictEqual(gv('diff', '--cached', '--name-only'), 'x.txt', 'con los cambios en stage');

  // en Windows un .cmd (claude instalado con npm) solo arranca con shell y los argumentos entrecomillados
  assert.deepStrictEqual(n.comandoWindows('C:\\npm\\claude.cmd', ['-p', 'a b', '']),
    { cmd: '"C:\\npm\\claude.cmd"', args: ['"-p"', '"a b"', '""'], shell: true });
  assert.deepStrictEqual(n.comandoWindows('C:\\x\\claude.exe', ['-p']), { cmd: 'C:\\x\\claude.exe', args: ['-p'], shell: false });
  assert.throws(() => n.comandoWindows('claude.cmd', ['%PATH%']), /claude/);
  console.log('OK');
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => [raiz, vacio].forEach(d => fs.rmSync(d, { recursive: true, force: true })));
