# Planificateur Cnam

Répartit les UE d'un diplôme du Cnam Paris sur tes semestres, et suit ce qui est planifié, ce à quoi tu es inscrit et ce qui est validé.

Le site est statique et publié sur GitHub Pages. Les programmes des diplômes sont lus sur le site du Cnam par des GitHub Actions et publiés en JSON avec le site. Les plans de chaque élève restent dans son navigateur, avec une synchronisation optionnelle vers un Gist secret de son compte GitHub.

## Utiliser le site

- **Créer un plan** : choisis un diplôme dans la liste, puis ses années, la rentrée et la durée.
- **Ajouter un diplôme absent de la liste** : colle l'adresse de sa fiche cnam-paris.fr dans le champ de recherche, puis « Demander l'ajout sur GitHub ». Une issue est ouverte, une Action lit la fiche, publie la maquette, répond dans l'issue et la ferme. Le site est mis à jour une à deux minutes plus tard.
- **Sauvegarder ou changer d'appareil** : « Exporter » télécharge tes plans en JSON, « Importer un fichier » les ajoute sans jamais écraser un plan existant.
- **Synchroniser** : crée un jeton GitHub avec la seule permission `gist`, puis colle-le dans la section de synchronisation de l'accueil. Les plans sont envoyés après chaque modification et récupérés à l'ouverture. Si un plan a changé sur deux appareils, le site demande quelle version garder.
- **Nouvelle maquette** : chaque lundi, une Action relit les fiches. Si un programme a changé, une nouvelle version datée est publiée. Les plans existants restent sur leur version, et un bandeau propose d'en faire une copie reportée sur la nouvelle maquette (par code d'UE). Les UE disparues sont signalées.

Dans un plan :

- **Programme** : UE obligatoires, groupes à choix (« 1 UE à choisir parmi », « 6 crédits à choisir parmi », « 4 UE dans au moins 3 domaines ») avec vérification des règles lisibles, et parcours alternatifs. Les règles d'exclusion ne sont pas vérifiées : le texte d'origine reste affiché.
- **Planning** : glisser-déposer des UE sur les semestres. Seules les colonnes où l'UE est proposée, avec une modalité acceptée, s'allument. Un clic sur une carte ouvre le détail, utile sur mobile et au clavier. Les UE annuelles occupent les deux semestres de l'année et comptent pour moitié sur chacun.
- **Déjà validé** : première colonne du planning, pour les UE obtenues avant le plan. Elles comptent comme validées sans occuper de semestre.
- **Correction des semestres** : si la fiche du Cnam n'est pas à jour, ouvre une UE et coche ses semestres réels. La correction vaut pour ce plan, est marquée « corrigé » et se retrouve dans Réglages.
- **Statuts** : Planifiée, Inscrite, Validée, Échouée. Une UE échouée reste dans l'historique de son semestre et revient dans « À placer ».
- **Autre** : éléments sans semestre sur la fiche (expérience professionnelle, mémoire, test d'anglais, UE non ouvertes). Ils sont hors planning, mais leurs crédits validés comptent dans la progression.

## Fonctionnement du dépôt

```
site/                       le site publié tel quel sur GitHub Pages
  app.js                    interface (JS natif, sans build)
  store.js                  plans dans le navigateur, export et import
  sync.js                   synchronisation avec un Gist, détection des conflits
  migrate.js                report d'un plan sur une nouvelle maquette
  data/catalog.json         diplômes publiés et leurs versions
  data/maquettes/<id>/<version>.json
cnam/                       lecture des fiches (Python), lancée par les Actions
  scraper.py                analyse de la fiche diplôme (div.schema)
  catalog.py                versions datées YYYYMMDD, créées seulement si le programme change
  __main__.py               python -m cnam import | refresh
.github/workflows/
  pages.yml                 tests puis publication sur Pages, à chaque push sur main
  import.yml                import à l'ouverture d'une issue « Ajouter un diplôme », ou à la main
  refresh.yml               relecture de tous les diplômes chaque lundi
```

Les commits faits par une Action ne relancent pas les autres workflows : `import.yml` et `refresh.yml` déclenchent donc eux-mêmes `pages.yml` après avoir enregistré les données. La relecture hebdomadaire commite au moins la date de vérification, ce qui évite que GitHub désactive la tâche planifiée après 60 jours sans activité.

## Développement

```bash
uv run pytest
```

```bash
uv run python -m cnam import --url "https://www.cnam-paris.fr/…kjsp"
```

Pour voir le site en local, au choix :

```bash
docker compose up -d
```

```bash
python3 -m http.server 8000 -d site
```

Puis ouvrir http://localhost:8000.
