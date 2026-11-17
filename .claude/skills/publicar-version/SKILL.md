---
name: publicar-version
description: Publicar una versión nueva de la extensión en el VS Code Marketplace y Open VSX (subir versión, CHANGELOG, PR con centinela, tag y seguir el CI hasta comprobar que sale). Usar cuando se pida «publica», «saca una versión», «release» o «sube la extensión».
---

# Publicar una versión

Publica GitHub Actions (`.github/workflows/publicar.yml`) al empujar un tag `v<version>` que apunte a un commit de `main`:
Marketplace por Trusted Publishing (OIDC, sin token) y Open VSX con el secret `OVSX_PAT` del environment `marketplace`.
Aquí solo se prepara la versión, se fusiona y se empuja el tag. Detalle para humanos: `PUBLICAR.md`.

## Pasos

1. **Punto de partida**: `git checkout main && git pull`, árbol limpio. Cambios desde la última versión:
   `git log --oneline $(git describe --tags --abbrev=0)..HEAD`. Si no hay nada que publicar, parar y decirlo.
2. **Versión**: patch para arreglos, minor para funciones nuevas o ajustes nuevos, major si rompe algo (un ajuste
   renombrado o quitado). Confirmar con el usuario si no es evidente.
3. **Rama y cambios**: `git checkout -b release/vX.Y.Z`, `npm version X.Y.Z --no-git-tag-version` (toca `package.json` y
   `package-lock.json`) y una sección `## X.Y.Z` arriba en `CHANGELOG.md`: en inglés, lo que nota quien la usa, no los
   commits internos.
4. **Comprobar**: `npm test` y `npx vsce package` sin avisos; borrar el `.vsix` generado.
5. **PR**: commit `chore: versión X.Y.Z`, push, `gh pr create`, y `gh centinela <n>` en segundo plano. Fusionar
   (`gh pr merge <n> --squash --delete-branch`) solo con centinela en verde en el último commit; si no, corregir y relanzar.
6. **Tag**: `git checkout main && git pull`, `git tag vX.Y.Z && git push origin vX.Y.Z`.
7. **Seguir el CI**: el run tarda unos segundos en aparecer; buscarlo en bucle con
   `gh run list --event push -L5 --json databaseId,headBranch -q '[.[]|select(.headBranch=="vX.Y.Z")][0].databaseId'`,
   luego `gh run watch <id> --exit-status` y confirmar en `gh run view <id> --log` las líneas
   `Published jlopez.commits-with-claude-code vX.Y.Z` (Marketplace) y `Published ...` del paso de Open VSX.
8. **Verificar**: el Marketplace tarda unos minutos en validar; la versión pública sale en
   ```sh
   curl -s -X POST 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery' \
     -H 'Content-Type: application/json' -H 'Accept: application/json;api-version=3.0-preview.1' \
     -d '{"filters":[{"criteria":[{"filterType":7,"value":"jlopez.commits-with-claude-code"}]}],"flags":1}' \
     | jq -r '.results[0].extensions[0].versions[0].version'
   ```
   y en `curl -s https://open-vsx.org/api/jlopez/commits-with-claude-code | jq -r .version` (Open VSX la escanea antes
   de mostrarla: puede dar «not found» un rato). Decir al usuario qué se ha visto y qué sigue pendiente de validar.
9. **Vault**: actualizar la línea de estado de `Proyectos/Commits with Claude Code/_proyecto.md` con la versión publicada.

## Si falla

- **El tag no coincide con `package.json`** o **no está en `main`**: borrar el tag (`git push origin :refs/tags/vX.Y.Z` y
  `git tag -d vX.Y.Z`), arreglar por PR y volver a etiquetar.
- **Marketplace rechaza el OIDC**: revisar la política de la pestaña Trusted Publishing del editor `jlopez` (owner
  `jlopez994`, repo `commits-with-claude-code`, workflow `publicar.yml`, environment `marketplace`). Requiere
  `@vscode/vsce` >= 4.1.
- **«version already exists»**: esa versión ya salió; subir otra.
- **Open VSX da 401/403**: token caducado o revocado. Pedir uno nuevo con `request_secret` (`delivery: "file"`), guardarlo
  con `gh secret set OVSX_PAT --env marketplace -R jlopez994/commits-with-claude-code < <fichero>`, borrar el fichero y
  relanzar solo ese job (`gh run rerun <id> --failed`). Si el Marketplace ya publicó, el rerun repite su paso y falla con
  «already exists»: en ese caso publicar Open VSX a mano con `npx vsce package -o ext.vsix && OVSX_PAT=... npx ovsx publish ext.vsix`.
