# Archiva — Notes pour Claude

## Dépôts GitHub
- `matteolicina9007/Analytica` — dépôt principal (visible dans l'historique de session)
- `optimawebpro-oss/Analytica` — dépôt Railway (remote nommé `railway`)

## ⚠️ Branche Railway CRITIQUE
Railway surveille la branche **`saas-archiva`** sur `optimawebpro-oss/Analytica`.
Toujours pousser avec :
```bash
git push railway main:saas-archiva
```
Ne jamais pousser uniquement sur `main` sinon le site ne se met PAS à jour.

## Pousser vers les deux dépôts
```bash
# dépôt principal
git push https://<PAT_MATTEO>@github.com/matteolicina9007/Analytica.git main
# dépôt Railway (branche saas-archiva !)
git push https://<PAT_RAILWAY>@github.com/optimawebpro-oss/Analytica.git main:saas-archiva
```

## Stack technique
- Frontend : HTML/CSS/JS vanilla (index.html, app.js, styles.css)
- Backend : Node.js + Express (server.js)
- Auth : Kinde PKCE
- Paiement : Stripe
- Déploiement : Railway
- Le remote `origin` (proxy local) est inutilisable — toujours passer par les URLs HTTPS avec PAT
