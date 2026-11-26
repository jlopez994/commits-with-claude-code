'use strict';
// Logica sin dependencias de vscode: git, claude -p, troceado del diff y aplicacion del plan de commits.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ARBOL_VACIO = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_DIFF_MENSAJE = 100000;
const MAX_PROMPT_DIVISION = 180000;

// la extension sustituye este traductor por vscode.l10n.t
let t = (mensaje, ...args) => mensaje.replace(/\{(\d+)\}/g, (_, i) => String(args[i]));

function setTraductor(fn) {
  t = fn;
}

class Cancelado extends Error {
  constructor() { super(t('Cancelled')); this.cancelado = true; }
}

/**
 * ejecuta un proceso y devuelve su salida estandar
 * @param 'cmd
 * @param 'args
 * @param 'opts cwd, input, inputEncoding, encoding, signal, timeoutMs
 * @returns stdout
 */
function ejecutar(cmd, args, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = cp.spawn(cmd, args, { cwd: opts.cwd, windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    const out = [];
    const err = [];
    let acabado = false;
    const terminar = (fn, valor) => {
      if (acabado) { return; }
      acabado = true;
      clearTimeout(temporizador);
      fn(valor);
    };
    const temporizador = opts.timeoutMs ? setTimeout(() => {
      proc.kill();
      terminar(reject, new Error(t('{0} did not respond within {1} s', path.basename(cmd), Math.round(opts.timeoutMs / 1000))));
    }, opts.timeoutMs) : undefined;
    if (opts.signal) {
      if (opts.signal.aborted) { proc.kill(); terminar(reject, new Cancelado()); }
      opts.signal.addEventListener('abort', () => { proc.kill(); terminar(reject, new Cancelado()); });
    }
    proc.stdout.on('data', d => out.push(d));
    proc.stderr.on('data', d => err.push(d));
    proc.on('error', e => terminar(reject, e));
    proc.on('close', codigo => {
      const stdout = Buffer.concat(out).toString(opts.encoding || 'utf8');
      if (codigo !== 0) {
        const detalle = Buffer.concat(err).toString('utf8').trim() || stdout.trim() || t('exit code {0}', codigo);
        terminar(reject, new Error(`${path.basename(cmd)} ${args[0] || ''}: ${detalle}`));
      } else {
        terminar(resolve, stdout);
      }
    });
    proc.stdin.on('error', () => { /* el proceso puede cerrar stdin antes de leerlo todo */ });
    if (opts.input !== undefined) {
      proc.stdin.end(Buffer.isBuffer(opts.input) ? opts.input : Buffer.from(opts.input, opts.inputEncoding || 'utf8'));
    } else {
      proc.stdin.end();
    }
  });
}

function git(raiz, args, opts) {
  return ejecutar('git', ['-c', 'core.quotePath=false', ...args], Object.assign({ cwd: raiz }, opts));
}

function especRutas(excluir) {
  return ['--', '.', ...(excluir || []).map(p => ':(exclude)' + p)];
}

// los diffs se leen en latin1 para conservar los bytes tal cual al rehacer los parches
function aUtf8(latin1) {
  return Buffer.from(latin1, 'latin1').toString('utf8');
}

function recortar(texto, maxLineas) {
  const lineas = texto.replace(/\n$/, '').split('\n');
  if (lineas.length <= maxLineas) { return lineas.join('\n'); }
  return lineas.slice(0, maxLineas).join('\n') + `\n[... ${lineas.length - maxLineas} more lines]`;
}

// null en un repo sin commits
async function cabeza(raiz) {
  try {
    return (await git(raiz, ['rev-parse', '--verify', '-q', 'HEAD'])).trim();
  } catch (e) {
    return null;
  }
}

async function base(raiz) {
  return (await cabeza(raiz)) ? 'HEAD' : ARBOL_VACIO;
}

function comoDeshacer(inicio) {
  return inicio ? `git reset --soft ${inicio}` : 'git update-ref -d HEAD';
}

async function contexto(raiz) {
  let rama = '';
  let recientes = '';
  try { rama = (await git(raiz, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); } catch (e) { rama = t('(no commits yet)'); }
  try { recientes = (await git(raiz, ['log', '-20', '--no-merges', '--format=%s'])).trim(); } catch (e) { recientes = ''; }
  return { rama, recientes };
}

async function enFusion(raiz) {
  try {
    await git(raiz, ['rev-parse', '--verify', '-q', 'MERGE_HEAD']);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * diff que se manda para el mensaje: lo que hay en stage, o todo si no hay nada en stage
 * @param 'raiz
 * @param 'excluir
 * @returns { fuente, diff } con diff vacio si no hay cambios
 */
async function diffParaMensaje(raiz, excluir) {
  const espec = especRutas(excluir);
  const comunes = ['--no-color', '--no-ext-diff'];
  let diff = await git(raiz, ['diff', '--cached', ...comunes, ...espec]);
  let fuente = 'staged changes';
  if (!diff.trim()) {
    diff = await git(raiz, ['diff', await base(raiz), ...comunes, ...espec]);
    const nuevos = (await git(raiz, ['ls-files', '--others', '--exclude-standard', ...espec])).trim();
    if (nuevos) { diff += '\nNew untracked files:\n' + nuevos + '\n'; }
    fuente = 'all changes (nothing is staged)';
  }
  if (!diff.trim()) { return { fuente, diff: '' }; }
  if (diff.length > MAX_DIFF_MENSAJE) {
    diff = diff.slice(0, MAX_DIFF_MENSAJE) + '\n[... diff truncated]';
  }
  return { fuente, diff };
}

const ESCAPES_GIT = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r' };

function rutaDeCabecera(linea) {
  // con --no-renames la linea es "diff --git a/<ruta> b/<ruta>" con la misma ruta dos veces
  const resto = linea.slice('diff --git '.length);
  // git entrecomilla al estilo C las rutas con ", \ o caracteres de control; los octales son bytes (latin1 aqui)
  const comillas = resto.match(/^"a\/((?:[^"\\]|\\.)*)"/);
  if (comillas) {
    return comillas[1].replace(/\\([0-7]{3}|.)/g, (_, e) => (e.length === 3 ? String.fromCharCode(parseInt(e, 8)) : ESCAPES_GIT[e] || e));
  }
  return resto.slice('a/'.length, (resto.length - ' b/'.length + 'a/'.length) / 2);
}

function muestraFichero(abs, maxLineas) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) { return '(not a regular file)'; }
    const buf = Buffer.alloc(Math.min(st.size, 64 * 1024));
    const fd = fs.openSync(abs, 'r');
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (buf.includes(0)) { return `(binary, ${st.size} bytes)`; }
    return recortar(buf.toString('utf8'), maxLineas) + (st.size > buf.length ? '\n[... truncated]' : '');
  } catch (e) {
    return '(unreadable)';
  }
}

/**
 * foto de HEAD y del stage antes de repartir, para no aplicar el plan si cambian mientras tanto
 * @param 'raiz
 * @param 'excluir
 * @returns { cabeza, indice, arbol } con indice el tree del indice y arbol ese mismo, o null si no hay nada en stage fuera de lo excluido
 */
async function foto(raiz, excluir) {
  if ((await git(raiz, ['ls-files', '-u'])).trim()) { throw new Error(t('There are unresolved conflicts: resolve them before splitting commits')); }
  const enStage = await git(raiz, ['diff', '--cached', '--name-only', ...especRutas(excluir)]);
  const indice = (await git(raiz, ['write-tree'])).trim();
  return { cabeza: await cabeza(raiz), indice, arbol: enStage.trim() ? indice : null };
}

/**
 * trocea los cambios respecto a HEAD en unidades: los de arbol si se pasa, o si no stage + arbol de trabajo + sin seguimiento;
 * un hunk de un fichero de texto modificado, o un fichero entero si es nuevo, borrado, binario, cambia de modo o porFichero
 * @param 'raiz
 * @param 'excluir
 * @param 'porFichero
 * @param 'arbol el de foto, o null
 * @returns unidades
 */
async function leerUnidades(raiz, excluir, porFichero, arbol) {
  const espec = especRutas(excluir);
  const diff = await git(raiz, ['diff', await base(raiz), ...(arbol ? [arbol] : []), '--no-renames', '--no-color', '--no-ext-diff',
    '--src-prefix=a/', '--dst-prefix=b/', '-U3', ...espec], { encoding: 'latin1' });
  const unidades = [];
  const nuevoId = () => 'U' + (unidades.length + 1);
  for (const bloque of diff.split(/^(?=diff --git )/m)) {
    if (!bloque.startsWith('diff --git ')) { continue; }
    const ruta = aUtf8(rutaDeCabecera(bloque.slice(0, bloque.indexOf('\n'))));
    const posiciones = [];
    const re = /^@@ /gm;
    let m;
    while ((m = re.exec(bloque))) { posiciones.push(m.index); }
    const cabecera = posiciones.length ? bloque.slice(0, posiciones[0]) : bloque;
    if (porFichero || !posiciones.length || /^(new file mode|deleted file mode|old mode|new mode|Binary files|GIT binary patch)/m.test(cabecera)) {
      const estado = /^new file mode/m.test(cabecera) ? 'new'
        : /^deleted file mode/m.test(cabecera) ? 'deleted'
          : /^(Binary files|GIT binary patch)/m.test(cabecera) ? 'binary' : 'modified';
      unidades.push({ id: nuevoId(), tipo: 'fichero', ruta, estado, muestra: aUtf8(bloque) });
      continue;
    }
    posiciones.forEach((pos, i) => {
      const texto = bloque.slice(pos, i + 1 < posiciones.length ? posiciones[i + 1] : bloque.length);
      unidades.push({ id: nuevoId(), tipo: 'hunk', ruta, cabecera, texto, orden: i, total: posiciones.length, muestra: aUtf8(texto) });
    });
  }
  if (arbol) { return unidades; }
  const otros = await git(raiz, ['ls-files', '--others', '--exclude-standard', '-z', ...espec]);
  for (const ruta of otros.split('\0').filter(Boolean)) {
    unidades.push({ id: nuevoId(), tipo: 'fichero', ruta, estado: 'untracked', muestra: muestraFichero(path.join(raiz, ruta), 80) });
  }
  return unidades;
}

// para el prompt, siempre en ingles
function describirParaClaude(u) {
  return u.tipo === 'hunk' ? `${u.ruta} (hunk ${u.orden + 1}/${u.total})` : `${u.ruta} (whole file, ${u.estado})`;
}

// para el usuario, traducido
function describirUnidad(u) {
  const estados = { new: t('new'), deleted: t('deleted'), binary: t('binary'), modified: t('modified'), untracked: t('untracked') };
  return u.tipo === 'hunk' ? t('{0} (chunk {1}/{2})', u.ruta, u.orden + 1, u.total) : t('{0} (file, {1})', u.ruta, estados[u.estado] || u.estado);
}

function cabeceraComun(ctx, extra) {
  const partes = [`Current branch: ${ctx.rama}`];
  partes.push(ctx.recientes
    ? 'Recent commit subjects on this branch:\n' + ctx.recientes.split('\n').map(l => '- ' + l).join('\n')
    : 'The repository has no commits yet.');
  if (extra && extra.trim()) { partes.push('Extra instructions from the user:\n' + extra.trim()); }
  return partes.join('\n\n');
}

const CONVENCIONES = 'Follow the commit conventions of this project that you have loaded (CLAUDE.md or similar): format, language, '
  + 'length, prefixes, ticket references derived from the branch name. If there are none, copy the style and language of the recent commits.';

function promptMensaje(ctx, cambios, extra) {
  return [
    'Write the commit message for the changes below.',
    '- ' + CONVENCIONES,
    '- Reply with the message only: no quotes, no code block, no explanations.',
    cabeceraComun(ctx, extra),
    `Changes (${cambios.fuente}):\n${cambios.diff}`,
  ].join('\n\n');
}

function promptDivision(ctx, unidades, extra, porFichero) {
  const unidadesSon = porFichero
    ? 'Each unit (U1, U2...) is a whole file with all its changes. Group them into atomic commits: each commit has a single intent '
    + 'and can be reverted without dragging anything else along. Do not split a single intent across several commits either.'
    : 'Each unit (U1, U2...) is a hunk of a file or a whole file. Group them into atomic commits: each commit has a single intent '
    + 'and can be reverted without dragging anything else along. Do not bundle unrelated changes just because they share a file: '
    + 'hunks of the same file may go into different commits. Do not split a single intent across several commits either.';
  const instrucciones = [
    'Split the pending changes of this repository into minimal commits.',
    unidadesSon,
    CONVENCIONES + ' The same conventions tell you which files must never be committed and what must not reach git.',
    'Put in "skip", with the reason, anything those conventions say must not be committed or that looks like a leftover: '
    + 'local configuration, debug traces, temporary or generated files.',
    'If the conventions forbid committing directly on the current branch, explain it in "warning" (otherwise leave it empty). '
    + 'Write "warning", "why" and "reason" in the language the commit messages use.',
    'Order the commits so that each one leaves the code consistent: whatever another commit needs goes first.',
    'Reply ONLY with JSON, no surrounding text and no code block, shaped like this:\n'
    + '{"warning": "", "commits": [{"message": "...", "why": "one sentence", "units": ["U1", "U3"]}], '
    + '"skip": [{"unit": "U7", "reason": "..."}]}\n'
    + 'Every unit appears exactly once, either in a commit or in "skip".',
    cabeceraComun(ctx, extra),
  ].join('\n\n');
  let texto;
  for (const maxLineas of [150, 40, 12]) {
    texto = instrucciones + '\n\nUnits:\n\n'
      + unidades.map(u => `### ${u.id} · ${describirParaClaude(u)}\n${recortar(u.muestra, maxLineas)}`).join('\n\n');
    if (texto.length <= MAX_PROMPT_DIVISION) { break; }
  }
  return texto;
}

/**
 * Node no lanza un .cmd sin shell: del shim que crea npm (cmd-shim) se saca su destino para lanzarlo directamente
 * @param 'rutaCmd
 * @param 'contenido texto del .cmd
 * @returns { cmd, args } con args los que van antes de los de claude
 */
function desdeShimNpm(rutaCmd, contenido) {
  const destinos = [...contenido.matchAll(/"%dp0%\\([^"]+)"/g)].map(m => m[1]).filter(d => !/(^|\\)node\.exe$/i.test(d));
  if (!destinos.length) { throw new Error(t('Cannot run {0}: set claudeCommit.claudePath to the claude executable', rutaCmd)); }
  const dir = path.win32.dirname(rutaCmd);
  const destino = path.win32.join(dir, destinos[destinos.length - 1]);
  if (!/\.js$/i.test(destino)) { return { cmd: destino, args: [] }; }
  // como el shim: el node.exe de su carpeta antes que el del PATH
  const nodeJunto = path.win32.join(dir, 'node.exe');
  return { cmd: fs.existsSync(nodeJunto) ? nodeJunto : 'node', args: [destino] };
}

function enPath(nombre) {
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(d => path.join(d, nombre)).find(f => fs.existsSync(f));
}

function comandoClaude(configurada) {
  let ruta = rutaClaude(configurada);
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(ruta)) {
    if (!path.isAbsolute(ruta)) { ruta = enPath(ruta) || ruta; }
    if (!fs.existsSync(ruta)) { throw new Error(t('Cannot run {0}: set claudeCommit.claudePath to the claude executable', ruta)); }
    return desdeShimNpm(ruta, fs.readFileSync(ruta, 'utf8'));
  }
  return { cmd: ruta, args: [] };
}

function rutaClaude(configurada) {
  if (configurada && configurada !== 'claude') { return configurada; }
  const win = process.platform === 'win32';
  const local = path.join(os.homedir(), '.local', 'bin', win ? 'claude.exe' : 'claude');
  if (fs.existsSync(local)) { return local; }
  if (!win) { return 'claude'; }
  // spawn solo prueba .exe en el PATH: el claude.cmd de npm hay que buscarlo
  return enPath('claude.exe') || enPath('claude.cmd') || 'claude';
}

/**
 * lanza claude -p desde la raiz del repo para que cargue su CLAUDE.md; el prompt va por stdin.
 * Sin hooks: los del usuario (SessionStart y demas) cambiarian el estilo del mensaje
 * @param 'opts ruta, modelo, cwd, entrada, signal, timeoutMs
 * @returns respuesta de claude
 */
function llamarClaude(opts) {
  const args = ['-p', 'Follow the instructions given on standard input.', '--model', opts.modelo,
    '--tools', '', '--strict-mcp-config', '--settings', path.join(__dirname, 'claude-settings.json')];
  const c = comandoClaude(opts.ruta);
  return ejecutar(c.cmd, [...c.args, ...args], { cwd: opts.cwd, input: opts.entrada, signal: opts.signal, timeoutMs: opts.timeoutMs });
}

function limpiarMensaje(texto) {
  let s = String(texto || '').trim();
  const bloque = s.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (bloque) { s = bloque[1].trim(); }
  if (!s.includes('\n') && /^(["'`]).*\1$/.test(s)) { s = s.slice(1, -1).trim(); }
  return s;
}

/**
 * valida el JSON de claude: ids conocidos, cada unidad una sola vez y lo no asignado a sinCommit
 * @param 'texto
 * @param 'unidades
 * @returns plan { aviso, commits: [{ mensaje, porque, unidades }], sinCommit: [{ unidad, motivo }] }
 */
function interpretarPlan(texto, unidades) {
  const ini = texto.indexOf('{');
  const fin = texto.lastIndexOf('}');
  if (ini < 0 || fin < ini) { throw new Error(t('Claude did not return JSON: {0}', texto.slice(0, 300))); }
  let bruto;
  try {
    bruto = JSON.parse(texto.slice(ini, fin + 1));
  } catch (e) {
    throw new Error(t('Claude returned invalid JSON ({0}): {1}', e.message, texto.slice(0, 300)));
  }
  const ids = new Set(unidades.map(u => u.id));
  const usadas = new Set();
  const tomar = id => {
    if (!ids.has(id) || usadas.has(id)) { return false; }
    usadas.add(id);
    return true;
  };
  const commits = (bruto.commits || [])
    .map(c => ({
      mensaje: limpiarMensaje(c.message),
      porque: String(c.why || '').trim(),
      unidades: (c.units || []).map(String).filter(tomar),
    }))
    .filter(c => c.mensaje && c.unidades.length);
  const sinCommit = (bruto.skip || [])
    .filter(s => tomar(String(s.unit)))
    .map(s => ({ unidad: String(s.unit), motivo: String(s.reason || '').trim() }));
  unidades.filter(u => !usadas.has(u.id)).forEach(u => sinCommit.push({ unidad: u.id, motivo: t('Claude did not assign it') }));
  return { aviso: String(bruto.warning || '').trim(), commits, sinCommit };
}

function numeroId(id) {
  return parseInt(id.slice(1), 10);
}

function construirParche(hunks) {
  const porRuta = new Map();
  hunks.slice().sort((a, b) => numeroId(a.id) - numeroId(b.id)).forEach(u => {
    if (!porRuta.has(u.ruta)) { porRuta.set(u.ruta, u.cabecera); }
    porRuta.set(u.ruta, porRuta.get(u.ruta) + u.texto);
  });
  let parche = Array.from(porRuta.values()).join('');
  if (!parche.endsWith('\n')) { parche += '\n'; }
  return parche;
}

const literales = rutas => rutas.map(r => ':(literal)' + r);

// ficheros enteros al indice: desde arbol o, sin el, desde el disco
function ficherosAlIndice(raiz, rutas, arbol) {
  return git(raiz, arbol ? ['reset', '-q', arbol, '--', ...literales(rutas)] : ['add', '-A', '--', ...literales(rutas)]);
}

// git apply encuentra cada hunk por su contexto aunque los commits anteriores hayan movido las lineas
function hunksAlIndice(raiz, hunks) {
  return git(raiz, ['apply', '--cached', '--whitespace=nowarn', '-'], { input: construirParche(hunks), inputEncoding: 'latin1' });
}

async function alIndice(raiz, unidades, arbol) {
  const hunks = unidades.filter(u => u.tipo === 'hunk');
  const rutas = unidades.filter(u => u.tipo === 'fichero').map(u => u.ruta);
  if (hunks.length) { await hunksAlIndice(raiz, hunks); }
  if (rutas.length) { await ficherosAlIndice(raiz, rutas, arbol); }
}

// lo del stage que no ha entrado en ningun commit vuelve al stage por unidades, no con read-tree, para no deshacer lo que un hook
// haya cambiado; cada hunk por separado porque uno que ya no encaja no debe impedir devolver los demas
async function devolverAlStage(raiz, porId, usados, arbol, excluidos, log) {
  const resto = Object.values(porId).filter(u => !usados.has(u.id));
  const rutas = resto.filter(u => u.tipo === 'fichero').map(u => u.ruta).concat(excluidos);
  const fallos = [];
  await git(raiz, ['reset', '-q']).catch(e => fallos.push(e.message));
  if (rutas.length) { await ficherosAlIndice(raiz, rutas, arbol).catch(e => fallos.push(e.message)); }
  for (const h of resto.filter(u => u.tipo === 'hunk')) {
    await hunksAlIndice(raiz, [h]).catch(() => fallos.push(describirUnidad(h)));
  }
  if (fallos.length) { log(t('Could not stage again what was left out: {0}', fallos.join('; '))); }
  return fallos;
}

/**
 * crea los commits del plan uno a uno rehaciendo el indice; el arbol de trabajo no se toca
 * @param 'raiz
 * @param 'commits
 * @param 'porId unidades por id
 * @param 'log
 * @param 'f la de foto: con arbol, los ficheros salen de el y lo que no entre en ningun commit sigue en stage
 * @returns { inicio, final, creados, sinDevolver } con los hashes para poder deshacer y lo que no ha vuelto al stage
 */
async function aplicarPlan(raiz, commits, porId, log, f) {
  const arbol = f && f.arbol;
  const inicio = await cabeza(raiz);
  if (f && (inicio !== f.cabeza || (await git(raiz, ['write-tree'])).trim() !== f.indice)) {
    throw new Error(t('HEAD or the staged changes have changed meanwhile: split again'));
  }
  log(t('Initial HEAD {0}; to undo the new commits: {1}', inicio || t('(no commits yet)'), comoDeshacer(inicio)));
  if (arbol) { log(t('Staged changes saved as {0}; to restore them: git read-tree {0}', arbol)); }
  // lo que estaba en stage pero no es ninguna unidad (claudeCommit.exclude) tambien vuelve al stage
  const deUnidades = new Set(Object.values(porId).map(u => u.ruta));
  const excluidos = arbol ? (await git(raiz, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(r => r && !deUnidades.has(r)) : [];
  await git(raiz, ['reset', '-q']);
  const creados = [];
  const usados = new Set();
  try {
    for (const c of commits) {
      await alIndice(raiz, c.unidades.map(id => porId[id]), arbol);
      await git(raiz, ['commit', '-q', '-m', c.mensaje]);
      c.unidades.forEach(id => usados.add(id));
      const hash = (await git(raiz, ['rev-parse', '--short', 'HEAD'])).trim();
      creados.push(hash);
      log(`  ${hash} ${c.mensaje}`);
    }
  } catch (e) {
    let perdido = '';
    if (arbol) {
      const sin = await devolverAlStage(raiz, porId, usados, arbol, excluidos, log);
      if (sin.length) { perdido = t(' Part of the staged changes could not be staged again; to restore them: git read-tree {0}.', arbol); }
    } else {
      await git(raiz, ['reset', '-q']).catch(() => undefined);
    }
    const hechos = creados.length ? t(' {0} commits were created; to undo them: {1}.', creados.length, comoDeshacer(inicio)) : '';
    throw new Error(t('Commit {0} failed: {1}.', creados.length + 1, e.message) + hechos + perdido);
  }
  const sinDevolver = arbol && (excluidos.length || usados.size < Object.keys(porId).length)
    ? await devolverAlStage(raiz, porId, usados, arbol, excluidos, log) : [];
  return { inicio, final: (await git(raiz, ['rev-parse', 'HEAD'])).trim(), creados, sinDevolver };
}

/**
 * deshace los commits creados dejando sus cambios en stage, solo si HEAD sigue donde lo dejamos
 * @param 'raiz
 * @param 'resultado lo que devuelve aplicarPlan
 */
async function deshacer(raiz, resultado) {
  const actual = (await git(raiz, ['rev-parse', 'HEAD'])).trim();
  if (actual !== resultado.final) { throw new Error(t('HEAD has moved since then: nothing was undone.')); }
  if (resultado.inicio) {
    await git(raiz, ['reset', '--soft', resultado.inicio]);
  } else {
    // primer commit del repo: borrar la rama deja los cambios en stage; con el valor esperado por si alguien la ha movido
    await git(raiz, ['update-ref', '-d', 'HEAD', resultado.final]);
  }
}

module.exports = {
  Cancelado, setTraductor, contexto, enFusion, diffParaMensaje, foto, leerUnidades, describirUnidad, promptMensaje, promptDivision,
  llamarClaude, limpiarMensaje, interpretarPlan, construirParche, aplicarPlan, deshacer, desdeShimNpm,
};
