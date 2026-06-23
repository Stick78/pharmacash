# PharmaCash — Guide de déploiement Vercel

## Structure du projet
```
pharmacash-app/
├── index.html
├── package.json
├── vite.config.js
├── vercel.json
├── public/
│   ├── manifest.json
│   └── sw.js
└── src/
    ├── main.jsx
    └── App.jsx
```

## Déploiement sur Vercel (méthode simple — sans GitHub)

### Option A : Via l'interface Vercel (recommandée)
1. Allez sur https://vercel.com
2. Créez un compte (avec Google, c'est le plus rapide)
3. Cliquez **"Add New Project"**
4. Choisissez **"Upload"** (pas besoin de GitHub)
5. Glissez-déposez le dossier **pharmacash-app** entier
6. Vercel détecte automatiquement que c'est un projet Vite/React
7. Cliquez **Deploy**
8. En 2 minutes vous avez une URL : `pharmacash-xxx.vercel.app`

### Option B : Via GitHub (pour les mises à jour automatiques)
1. Créez un compte GitHub (github.com)
2. Créez un nouveau repository "pharmacash"
3. Uploadez tous les fichiers de ce dossier
4. Sur Vercel → Import Git Repository → sélectionnez "pharmacash"
5. Chaque fois que vous mettez à jour App.jsx sur GitHub,
   Vercel redéploie automatiquement

## Tester en local (optionnel)
Si vous avez Node.js installé :
```bash
npm install
npm run dev
```
Ouvrez http://localhost:5173

## Comptes de connexion par défaut
| Email | Mot de passe | Rôle |
|---|---|---|
| admin@pharmacie.com | admin123 | Administrateur |
| caisse@pharmacie.com | caisse123 | Caissier |
| compta@pharmacie.com | compta123 | Comptable |
| gerant@pharmacie.com | gerant123 | Gérant |

⚠️ Changez ces mots de passe après la première connexion !

## Installer l'app sur téléphone
**Android (Chrome) :**
Ouvrir l'URL → menu ⋮ → "Ajouter à l'écran d'accueil"

**iPhone (Safari uniquement) :**
Ouvrir l'URL → bouton Partager → "Sur l'écran d'accueil"
