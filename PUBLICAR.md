# Publicar la extension

Queda lista para el Marketplace de VS Code (y opcionalmente Open VSX, que es el que usan Cursor, VSCodium y similares).
Lo que esta en el Marketplace es **publico**.

## Una sola vez

1. Crear el editor (publisher) en <https://marketplace.visualstudio.com/manage> con la cuenta Microsoft. Su id va en
   `package.json` -> `"publisher"` (ahora `jlopez`).
2. Politica de Trusted Publishing (ver abajo). Los PAT globales de Azure DevOps dejan de valer el 2026-12-01.
3. Repositorio publico: <https://github.com/jlopez994/commits-with-claude-code>, ya en `package.json` (`repository`, `bugs`,
   `homepage`).
4. Icono: `images/icon.svg` es la fuente; `images/icon.png` (256 px) se rasteriza de ahi.

## Cada version

La publica GitHub Actions (`.github/workflows/publicar.yml`) al empujar un tag `v<version>`; cada PR y push a `main` pasa
tests y `vsce package`. Sin token: usa Trusted Publishing (OIDC), con una politica en la pestana **Trusted Publishing** del
editor `jlopez` (owner `jlopez994`, repo `commits-with-claude-code`, workflow `publicar.yml`, environment `marketplace`). El
environment `marketplace` del repo solo admite tags `v*`.

1. Subir `version` en `package.json` y apuntar los cambios en `CHANGELOG.md`.
2. Fusionar en `main`, y luego `git tag v<version> && git push origin v<version>`.

A mano (Node 22 o superior): `npx vsce package` y subir el VSIX en la pagina del editor.

Open VSX (Cursor, VSCodium): el mismo job publica alli si existe el secret `OVSX_PAT` del environment `marketplace`. Una vez:
cuenta en <https://open-vsx.org> con GitHub, firmar el Publisher Agreement, crear un token en Settings > Access Tokens,
`npx ovsx create-namespace jlopez -p <token>` y
`gh secret set OVSX_PAT --env marketplace -R jlopez994/commits-with-claude-code`.

## Tenerla en todos los VS Code

- Settings Sync la instala sola en los VS Code locales una vez publicada.
- En los remotos (Remote-SSH) no se instala sola: anadir `"remote.SSH.defaultExtensions": ["jlopez.commits-with-claude-code"]`
  en los ajustes de usuario, o instalarla una vez en cada servidor desde la vista de extensiones.

## Mientras no se publique

`scripts/empaquetar-local.ps1` genera el VSIX sin vsce. En un servidor remoto se instala con:

```powershell
& "$env:USERPROFILE\.vscode-server\cli\servers\Stable-<commit>\server\bin\code-server.cmd" --install-extension <vsix> --force
```

(`code-server` se queda colgado despues de instalar; se puede cortar.) En un VS Code local: Extensions -> ... -> Install from VSIX.

## Nombre

El id (`name`) es `commits-with-claude-code`: `claude-code-commits` ya lo usa otra extension y el Marketplace no admite
dos con el mismo nombre aunque sean de editores distintos.
Lleva "(unofficial)" y el README dice que no es de Anthropic: "Claude" es su marca. No usar su logo como icono.
