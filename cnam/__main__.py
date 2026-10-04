"""Commandes lancées par les GitHub Actions.

    python -m cnam import --url URL [--comment FICHIER]
    python -m cnam import --issue-body-env VARIABLE [--comment FICHIER]
    python -m cnam crawl [--no-discovery] [--delay SECONDES] [--limit N] [--summary FICHIER]

Les résultats sont aussi écrits dans $GITHUB_OUTPUT (changed, ok) pour les étapes suivantes.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import datetime
from pathlib import Path

from . import crawl
from .catalog import DATA_DIR, Catalog
from .scraper import ScrapeError, normalize_url

URL_RE = re.compile(r"https?://[^\s<>()\"']+")


def site_url() -> str | None:
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not repo:
        return None
    owner, name = repo.split("/", 1)
    return f"https://{owner.lower()}.github.io/{name}/"


def set_output(**values: object) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            for k, v in values.items():
                f.write(f"{k}={str(v).lower() if isinstance(v, bool) else v}\n")


def extract_url(text: str) -> str:
    """Première adresse de fiche Cnam trouvée dans un texte (corps d'issue)."""
    for candidate in URL_RE.findall(text or ""):
        try:
            return normalize_url(candidate.rstrip(".,;"))
        except ScrapeError:
            continue
    raise ScrapeError("Aucune adresse de fiche diplôme du Cnam (cnam-paris.fr ou cnam.fr) trouvée dans la demande.")


def open_catalog(root: Path) -> Catalog:
    catalog = Catalog(root)
    if repo := os.environ.get("GITHUB_REPOSITORY"):
        catalog.data["repo"] = repo
    return catalog


def cmd_import(args: argparse.Namespace) -> int:
    catalog = open_catalog(args.root)
    link = site_url()
    try:
        url = normalize_url(args.url) if args.url else extract_url(os.environ.get(args.issue_body_env, ""))
        result = catalog.import_url(url, datetime.now())
    except ScrapeError as exc:
        message = (
            f"Impossible d'importer ce diplôme : {exc}\n\n"
            "Vérifie que l'adresse est celle d'une fiche diplôme du Cnam Paris "
            "(page avec un onglet Programme), puis ouvre une nouvelle demande."
        )
        print(message, file=sys.stderr)
        write(args.comment, message)
        set_output(ok=False, changed=False)
        return 0

    page = f"{link}#/nouveau/{result.diploma_id}" if link else None
    if result.created and result.previous:
        lead = f"Nouvelle version **{result.version}** de **{result.title}** publiée (la précédente était {result.previous})."
    elif result.created:
        lead = f"**{result.title}** ({result.code or 'sans code'}) est ajouté au site, version **{result.version}**."
    else:
        lead = f"**{result.title}** est déjà sur le site et son programme n'a pas changé (version **{result.version}**)."
    lines = [lead]
    if page:
        lines.append(f"\nPour créer un plan : {page}")
        if result.created:
            lines.append("\nLe site est republié automatiquement : compte une à deux minutes avant qu'il apparaisse.")
    write(args.comment, "\n".join(lines))
    print("\n".join(lines))
    set_output(ok=True, changed=result.created, diploma=result.diploma_id, version=result.version)
    return 0


def cmd_crawl(args: argparse.Namespace) -> int:
    catalog = open_catalog(args.root)
    crawler = crawl.Crawler(catalog, index_path=args.index, delay=args.delay)
    report = crawler.run(discover=not args.no_discovery, limit=args.limit)
    text = crawl.summary(report, catalog)
    print(text)
    write(args.summary or os.environ.get("GITHUB_STEP_SUMMARY"), text)
    set_output(changed=bool(report["new"] or report["versions"] or report["retired"] or report["restored"]))
    return 0


def write(path: str | None, text: str) -> None:
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(text + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m cnam")
    parser.add_argument("--root", type=Path, default=DATA_DIR, help="dossier des données publiées")
    sub = parser.add_subparsers(dest="command", required=True)

    imp = sub.add_parser("import", help="importer ou mettre à jour un diplôme")
    src = imp.add_mutually_exclusive_group(required=True)
    src.add_argument("--url")
    src.add_argument("--issue-body-env", help="variable d'environnement contenant le texte de l'issue")
    imp.add_argument("--comment", help="fichier où écrire la réponse à publier")
    imp.set_defaults(func=cmd_import)

    crw = sub.add_parser("crawl", help="découvrir les diplômes du sitemap et relire ceux du catalogue")
    crw.add_argument("--index", type=Path, default=crawl.INDEX_PATH, help="classement des pages déjà vues")
    crw.add_argument("--no-discovery", action="store_true", help="relire seulement les diplômes déjà connus")
    crw.add_argument("--delay", type=float, default=1.0, help="pause entre deux requêtes (secondes)")
    crw.add_argument("--limit", type=int, help="nombre maximal de pages lues (essai)")
    crw.add_argument("--summary", help="fichier où écrire le récapitulatif")
    crw.set_defaults(func=cmd_crawl)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
