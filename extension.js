'use strict';
const vscode = require('vscode');
const n = require('./nucleo');

const t = vscode.l10n.t;
let salida;

function log(texto) {
  salida.appendLine(texto);
}

function activate(context) {
  n.setTraductor((mensaje, ...args) => t(mensaje, ...args));
  salida = vscode.window.createOutputChannel('Claude commits');
  context.subscriptions.push(
    salida,
    vscode.commands.registerCommand('claudeCommit.generar', arg => protegido(() => generar(arg))),
    vscode.commands.registerCommand('claudeCommit.dividir', arg => protegido(() => dividir(arg))),
  );
}

function deactivate() { }

async function protegido(fn) {
  try {
    await fn();
  } catch (e) {
    if (e && e.cancelado) { return; }
    log('ERROR ' + ((e && e.stack) || e));
    const ver = t('Show output');
    const r = await vscode.window.showErrorMessage('Claude commits: ' + ((e && e.message) || e), ver);
    if (r === ver) { salida.show(); }
  }
}

function ajustes(uri) {
  const c = vscode.workspace.getConfiguration('claudeCommit', uri);
  return {
    ruta: c.get('claudePath', 'claude'),
    modeloMensaje: c.get('messageModel', 'haiku'),
    modeloDivision: c.get('splitModel', 'sonnet'),
    excluir: c.get('exclude', []),
    extra: c.get('extraInstructions', ''),
    timeoutMs: c.get('timeoutSeconds', 180) * 1000,
    porFichero: c.get('splitBy', 'file') !== 'hunk',
    confirmar: c.get('confirm', 'confirm'),
  };
}

async function obtenerRepo(arg) {
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext) { throw new Error(t('The VS Code git extension is not available')); }
  const api = (await ext.activate()).getAPI(1);
  const repos = api.repositories;
  if (!repos.length) {
    vscode.window.showWarningMessage(t('No git repository is open'));
    return undefined;
  }
  // desde la fila de un repositorio llega su SourceControl; desde la barra del panel puede no llegar nada
  if (arg && arg.rootUri) {
    const r = api.getRepository(arg.rootUri);
    if (r) { return r; }
  }
  if (repos.length === 1) { return repos[0]; }
  const seleccionados = repos.filter(r => r.ui && r.ui.selected);
  if (seleccionados.length === 1) { return seleccionados[0]; }
  const editor = vscode.window.activeTextEditor;
  const delEditor = editor && api.getRepository(editor.document.uri);
  if (delEditor) { return delEditor; }
  const elegido = await vscode.window.showQuickPick(
    repos.map(r => ({ label: r.rootUri.fsPath.split(/[\\/]/).pop(), description: r.rootUri.fsPath, repo: r })),
    { placeHolder: t('Repository') });
  return elegido && elegido.repo;
}

function senalDe(token) {
  const ac = new AbortController();
  token.onCancellationRequested(() => ac.abort());
  return ac.signal;
}

async function generar(arg) {
  const repo = await obtenerRepo(arg);
  if (!repo) { return; }
  const raiz = repo.rootUri.fsPath;
  const a = ajustes(repo.rootUri);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: '$(sparkle) ' + t('Claude: generating commit message') },
    () => vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl }, async () => {
      const cambios = await n.diffParaMensaje(raiz, a.excluir);
      if (!cambios.diff) {
        vscode.window.showInformationMessage(t('No changes to describe'));
        return;
      }
      const ctx = await n.contexto(raiz);
      const respuesta = await n.llamarClaude({
        ruta: a.ruta, modelo: a.modeloMensaje, cwd: raiz, entrada: n.promptMensaje(ctx, cambios, a.extra), timeoutMs: a.timeoutMs,
      });
      const mensaje = n.limpiarMensaje(respuesta);
      if (!mensaje) { throw new Error(t('Claude returned an empty message')); }
      repo.inputBox.value = mensaje;
    }));
}

async function dividir(arg) {
  const repo = await obtenerRepo(arg);
  if (!repo) { return; }
  const raiz = repo.rootUri.fsPath;
  const a = ajustes(repo.rootUri);
  if (await n.enFusion(raiz)) { throw new Error(t('A merge is in progress: finish or abort it before splitting commits')); }

  const preparado = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('Claude: splitting changes into commits'), cancellable: true },
    async (progreso, token) => {
      const f = await n.foto(raiz, a.excluir);
      const unidades = await n.leerUnidades(raiz, a.excluir, a.porFichero, f.arbol);
      if (!unidades.length) { return undefined; }
      progreso.report({ message: t('{0} chunks', unidades.length) });
      const ctx = await n.contexto(raiz);
      const respuesta = await n.llamarClaude({
        ruta: a.ruta, modelo: a.modeloDivision, cwd: raiz, entrada: n.promptDivision(ctx, unidades, a.extra, a.porFichero),
        signal: senalDe(token), timeoutMs: a.timeoutMs,
      });
      return { f, unidades, ctx, plan: n.interpretarPlan(respuesta, unidades) };
    });
  if (!preparado) {
    vscode.window.showInformationMessage(t('No changes to split'));
    return;
  }

  const { f, unidades, ctx, plan } = preparado;
  const porId = {};
  unidades.forEach(u => { porId[u.id] = u; });
  volcarPlan(plan, porId, ctx);
  if (!plan.commits.length) {
    const ver = t('Show output');
    vscode.window.showWarningMessage(t('Claude proposes no commits') + (plan.aviso ? ': ' + plan.aviso : ''), ver)
      .then(r => r === ver && salida.show());
    return;
  }

  const elegidos = a.confirmar === 'review' ? await revisar(plan, porId, ctx) : plan.commits;
  if (!elegidos || !elegidos.length) { return; }
  // un aviso de Claude (rama protegida, por ejemplo) siempre se confirma, aunque el ajuste diga que no se pregunte
  if (a.confirmar !== 'none' || plan.aviso) {
    const detalle = [
      plan.aviso && t('WARNING: {0}', plan.aviso),
      elegidos.map((c, i) => `${i + 1}. ${c.mensaje}\n    ${ficherosDe(c, porId)}`).join('\n'),
      plan.sinCommit.length && t('{0} chunks stay uncommitted (details in the "Claude commits" output).', plan.sinCommit.length),
      f.arbol
        ? t('Only the staged changes are split; anything not staged stays as it is.')
        : t('The index is rebuilt (anything staged is split again); the working tree is not touched.'),
    ].filter(Boolean).join('\n\n');
    const crear = t('Create commits');
    const ok = await vscode.window.showWarningMessage(t('Create {0} commits on {1}?', elegidos.length, ctx.rama),
      { modal: true, detail: detalle }, crear);
    if (ok !== crear) { return; }
  }

  log(t('Creating {0} commits on {1}', elegidos.length, ctx.rama));
  const resultado = await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl },
    () => n.aplicarPlan(raiz, elegidos, porId, log, f));
  await repo.status();
  const ver = t('Show output');
  const deshacer = t('Undo');
  if (resultado.sinDevolver.length) {
    vscode.window.showWarningMessage(t('Some staged changes could not be staged again (details in the "Claude commits" output).'), ver)
      .then(w => w === ver && salida.show());
  }
  const r = await vscode.window.showInformationMessage(t('{0} commits created on {1}', resultado.creados.length, ctx.rama), ver, deshacer);
  if (r === ver) { salida.show(); }
  if (r === deshacer) {
    await n.deshacer(raiz, resultado);
    await repo.status();
    log(t('Commits undone: the changes are staged again.'));
    vscode.window.showInformationMessage(t('Commits undone: the changes are staged again.'));
  }
}

function ficherosDe(commit, porId) {
  const cuenta = new Map();
  commit.unidades.forEach(id => {
    const u = porId[id];
    const previo = cuenta.get(u.ruta) || { n: 0, total: u.tipo === 'hunk' ? u.total : 0 };
    previo.n++;
    cuenta.set(u.ruta, previo);
  });
  return Array.from(cuenta.entries()).map(([ruta, c]) => (c.total ? `${ruta} (${c.n}/${c.total})` : ruta)).join(', ');
}

function volcarPlan(plan, porId, ctx) {
  log('');
  log(t('=== Commit plan for {0} · {1} ===', ctx.rama, new Date().toLocaleString()));
  if (plan.aviso) { log(t('WARNING: {0}', plan.aviso)); }
  plan.commits.forEach((c, i) => {
    log(`${i + 1}. ${c.mensaje}`);
    if (c.porque) { log(`   ${c.porque}`); }
    c.unidades.forEach(id => log(`   - ${n.describirUnidad(porId[id])}`));
  });
  if (plan.sinCommit.length) {
    log(t('Not committed:'));
    plan.sinCommit.forEach(s => log(`   - ${n.describirUnidad(porId[s.unidad])}: ${s.motivo}`));
  }
  salida.show(true);
}

function revisar(plan, porId, ctx) {
  return new Promise(resolve => {
    const qp = vscode.window.createQuickPick();
    qp.canSelectMany = true;
    qp.ignoreFocusOut = true;
    qp.matchOnDetail = true;
    qp.title = t('Proposed commits for {0}', ctx.rama) + (plan.sinCommit.length ? t(' · {0} chunks left out (see output)', plan.sinCommit.length) : '');
    qp.placeholder = plan.aviso ? t('WARNING: {0}', plan.aviso) : t('Uncheck what you do not want and edit messages with the pencil. Enter to continue');
    const boton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: t('Edit message') };
    const crearItems = () => plan.commits.map(c => ({
      label: c.mensaje, description: c.porque, detail: ficherosDe(c, porId), buttons: [boton], commit: c,
    }));
    qp.items = crearItems();
    qp.selectedItems = qp.items;
    let editando = false;
    let terminado = false;
    qp.onDidTriggerItemButton(async e => {
      const marcados = new Set(qp.selectedItems.map(i => i.commit));
      editando = true;
      const nuevo = await vscode.window.showInputBox({ value: e.item.commit.mensaje, prompt: t('Commit message'), ignoreFocusOut: true });
      editando = false;
      if (nuevo && nuevo.trim()) { e.item.commit.mensaje = nuevo.trim(); }
      qp.items = crearItems();
      qp.selectedItems = qp.items.filter(i => marcados.has(i.commit));
      qp.show();
    });
    qp.onDidAccept(() => {
      terminado = true;
      const marcados = new Set(qp.selectedItems.map(i => i.commit));
      qp.hide();
      resolve(plan.commits.filter(c => marcados.has(c)));
    });
    // al abrir el input de edicion el quick pick se oculta: no es una cancelacion
    qp.onDidHide(() => {
      if (editando) { return; }
      if (!terminado) {
        terminado = true;
        resolve(undefined);
      }
      qp.dispose();
    });
    qp.show();
  });
}

module.exports = { activate, deactivate };
