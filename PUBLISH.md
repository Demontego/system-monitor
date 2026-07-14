# Publish checklist

## 1. GitHub

```bash
cd system-monitor
git init
git add .
git commit -m "release: system-monitor 1.0.0"
# create repo demontego/system-monitor on GitHub, then:
git remote add origin https://github.com/demontego/system-monitor.git
git push -u origin main
```

If your GitHub username differs, fix `repository` / `bugs` / `homepage` in `package.json`.

## 2. Open VSX (required for Cursor)

1. Sign in: https://open-vsx.org/
2. Create namespace/publisher `demontego` (or change `publisher` in package.json to match)
3. Create access token: https://open-vsx.org/user-settings/tokens
4. Publish:

```bash
npm run compile
npx ovsx publish -p YOUR_OPEN_VSX_TOKEN
```

Wait a few hours for Cursor marketplace sync. Search: `System Monitor CPU RAM`.

## 3. VS Code Marketplace (optional)

1. https://marketplace.visualstudio.com/manage → create publisher `demontego`
2. Azure DevOps PAT with Marketplace (publish) scope, or Entra ID publish flow
3. `npx vsce publish`

## 4. Local VSIX

```bash
npx vsce package
```
