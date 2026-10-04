# Planificateur Cnam

Répartit les UE d'un diplôme du Cnam Paris sur tes semestres, et suit ce qui est planifié, ce à quoi tu es inscrit et ce qui est validé.

Le site est statique et publié sur GitHub Pages. Chaque lundi, une GitHub Action parcourt le sitemap du Cnam Paris, découvre toutes les fiches diplôme (licences, masters, DEUST, diplômes d'ingénieur, titres RNCP, certificats, doctorats…), relit leur programme et le publie en JSON avec le site. Les plans de chaque élève restent dans son navigateur, avec une synchronisation optionnelle vers un Gist secret de son compte GitHub.

## Utiliser le site

- **Créer un plan** : cherche ton diplôme (texte, type, niveau de sortie), puis choisis ses années, la rentrée et la durée. La dernière maquette est proposée, les anciennes restent accessibles dans un menu déroulant.
- **Mentions** : « semestres non indiqués par le Cnam » quand la fiche ne donne aucun semestre (on corrige alors les semestres à la main dans le plan), « plus proposée » quand la formation a disparu du site du Cnam (elle reste planifiable).
- **Diplôme absent de la liste** (fiche hors du sitemap, nouveauté pas encore vue) : colle l'adresse de sa fiche dans le champ de recherche, puis « Demander l'ajout sur GitHub ». Une issue est ouverte, une Action lit la fiche, publie la maquette, répond dans l'issue et la ferme.
- **Sauvegarder ou changer d'appareil** : « Exporter » télécharge tes plans en JSON, « Importer un fichier » les ajoute sans jamais écraser un plan existant.
- **Synchroniser** : crée un jeton GitHub avec la seule permission `gist`, puis colle-le dans la section de synchronisation de l'accueil. Les plans sont envoyés après chaque modification et récupérés à l'ouverture. Si un plan a changé sur deux appareils, le site demande quelle version garder.
- **Nouvelle maquette** : si un programme a changé lors de la relecture du lundi, une nouvelle version datée est publiée. Les plans existants restent sur leur version, et un bandeau propose d'en faire une copie reportée sur la nouvelle maquette (par code d'UE). Les UE disparues sont signalées.

Dans un plan :

- **Programme** : UE obligatoires, groupes à choix (« 1 UE à choisir parmi », « 6 crédits à choisir parmi », « 4 UE dans au moins 3 domaines ») avec vérification des règles lisibles, et parcours alternatifs. Les règles d'exclusion ne sont pas vérifiées : le texte d'origine reste affiché.
- **Planning** : glisser-déposer des UE sur les semestres. Seules les colonnes où l'UE est proposée, avec une modalité acceptée, s'allument. Un clic sur une carte ouvre le détail, utile sur mobile et au clavier. Les UE annuelles occupent les deux semestres de l'année et comptent pour moitié sur chacun.
- **Déjà validé** : première colonne du planning, pour les UE obtenues avant le plan. Elles comptent comme validées sans occuper de semestre.
- **Correction des semestres** : si la fiche du Cnam n'est pas à jour, ouvre une UE et coche ses semestres réels. La correction vaut pour ce plan, est marquée « corrigé » et se retrouve dans Réglages.
- **Statuts** : Planifiée, Inscrite, Validée, Échouée. Une UE échouée reste dans l'historique de son semestre et revient dans « À placer ».
- **Autre** : éléments sans semestre sur la fiche (expérience professionnelle, mémoire, test d'anglais, UE non ouvertes). Ils sont hors planning mais ont les mêmes statuts que les UE (Planifiée, Inscrite, Validée, Échouée) et comptent de la même façon dans la progression.

## Fonctionnement du dépôt

```
site/                       le site publié tel quel sur GitHub Pages
  app.js                    interface (JS natif, sans build)
  store.js                  plans dans le navigateur, export et import
  sync.js                   synchronisation avec un Gist, détection des conflits
  migrate.js                report d'un plan sur une nouvelle maquette
  data/catalog.json         diplômes publiés et leurs versions
  data/maquettes/<code>/<version>.json
cnam/                       lecture des fiches (Python), lancée par les Actions
  scraper.py                analyse d'une fiche diplôme (div.schema), classement des pages
  catalog.py                diplômes identifiés par leur code ; versions YYYYMMDD créées seulement si le programme change
  crawl.py                  découverte par le sitemap, relecture, formations retirées
  __main__.py               python -m cnam import | crawl
crawl/index.json            classement des pages déjà vues (diplôme, UE, autre), non publié
.github/workflows/
  pages.yml                 tests puis publication sur Pages, à chaque push sur main
  import.yml                import à l'ouverture d'une issue « Ajouter un diplôme », ou à la main
  crawl.yml                 découverte et relecture de tous les diplômes chaque lundi
```

Un diplôme est identifié par son code (`CYC9106A-PAR`) et non par son adresse, qui peut changer : une nouvelle adresse met à jour la fiche existante. Les anciens identifiants restent des alias, et les plans qui les utilisent sont convertis à l'ouverture.

Le sitemap est la source autorisée par le `robots.txt` du Cnam (qui interdit `/servlet/`). Ses dates de modification sont identiques pour toutes les pages, donc les fiches diplôme sont relues chaque semaine (environ 340 requêtes, une par seconde). Les pages d'UE ne sont lues qu'une fois, pour les classer. Un diplôme n'est marqué « plus proposé » que s'il disparaît du sitemap, jamais à cause d'une erreur de lecture.

Les commits faits par une Action ne relancent pas les autres workflows : `import.yml` et `crawl.yml` déclenchent donc eux-mêmes `pages.yml` après avoir enregistré les données. La relecture hebdomadaire commite au moins la date de vérification, ce qui évite que GitHub désactive la tâche planifiée après 60 jours sans activité.

## Développement

```bash
uv run pytest
```

```bash
uv run python -m cnam import --url "https://www.cnam-paris.fr/…kjsp"
```

```bash
uv run python -m cnam crawl --limit 20
```

Pour voir le site en local, au choix :

```bash
docker compose up -d
```

```bash
python3 -m http.server 8000 -d site
```

Puis ouvrir http://localhost:8000.
