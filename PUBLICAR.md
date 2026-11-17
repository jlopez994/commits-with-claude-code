# Publicar la extension

Queda lista para el Marketplace de VS Code (y opcionalmente Open VSX, que es el que usan Cursor, VSCodium y similares).
Lo que esta en el Marketplace es **publico**.

## Una sola vez

1. Crear el editor (publisher) en <https://marketplace.visualstudio.com/manage> con la cuenta Microsoft. Su id va en
   `package.json` -> `"publisher"` (ahora `jlopez`).
2. Token: en <https://dev.azure.com> (misma cuenta) -> User settings -> Personal access tokens -> New token, organizacion
   **All accessible organizations**, scope **Marketplace > Manage**.
3. Repositorio publico: <https://github.com/jlopez994/commits-with-claude-code>, ya en `package.json` (`repository`, `bugs`,
   `homepage`).
4. Opcional: icono PNG de 128x128 en `images/icon.png` y `"icon": "images/icon.png"` en `package.json`.

## Cada version

Hace falta Node 20 o superior.

```sh
npm ci
npm test
npx vsce login jlopez                    # solo la primera vez, pide el token (pegarlo aqui, no en el chat)
npx vsce publish                         # publica la version de package.json; "publish patch" la sube antes
```

Open VSX (opcional): `npx ovsx publish -p <token-open-vsx>`.

Antes de publicar, apuntar los cambios en `CHANGELOG.md`.

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
