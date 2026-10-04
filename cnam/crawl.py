"""Découverte et relecture hebdomadaire de toutes les fiches diplôme du Cnam Paris.

Source : le sitemap officiel (autorisé par robots.txt). Ses dates de modification ne sont pas
fiables (toutes les pages portent la date du jour), donc on relit les fiches elles-mêmes :

  - une page jamais vue est lue une fois pour la classer (diplôme, UE, autre) ;
  - les pages d'UE et les autres pages ne sont jamais relues ;
  - les fiches diplôme sont relues à chaque passage ; une version n'est créée que si le programme change ;
  - un diplôme absent du sitemap est marqué « plus proposé », jamais supprimé.

Le classement est gardé dans crawl/index.json, hors du site publié.
"""

from __future__ import annotations

import json
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

from . import scraper
from .catalog import Catalog

SITEMAP_URL = "https://www.cnam-paris.fr/sitemap.xml"
INDEX_PATH = Path(__file__).resolve().parent.parent / "crawl" / "index.json"
REREAD = ("diplome", "sans-programme")


def sitemap_urls(xml: str) -> list[str]:
    """Adresses des pages de formation listées dans le sitemap."""
    urls = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", xml)
    return sorted({u for u in urls if "/choisir-ma-formation/" in u and u.endswith(".kjsp")})


def page_key(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.hostname}{parts.path}"


class Crawler:
    def __init__(
        self,
        catalog: Catalog,
        index_path: Path = INDEX_PATH,
        fetch: Callable[[str], str] | None = None,
        delay: float = 1.0,
        now: Callable[[], datetime] = datetime.now,
        log: Callable[[str], None] = print,
    ):
        self.catalog = catalog
        self.index_path = index_path
        self.fetch = fetch or scraper.fetch
        self.delay = delay
        self.now = now
        self.log = log
        self.index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {"pages": {}}
        self._requests = 0

    @property
    def pages(self) -> dict:
        return self.index["pages"]

    def _get(self, url: str) -> str:
        if self._requests and self.delay:
            time.sleep(self.delay)  # une requête par seconde au plus vers le site du Cnam
        self._requests += 1
        return self.fetch(url)

    def save(self) -> None:
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        self.index["pages"] = dict(sorted(self.pages.items()))
        self.index_path.write_text(json.dumps(self.index, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    def run(self, discover: bool = True, limit: int | None = None) -> dict:
        report = {"new": [], "versions": [], "retired": [], "restored": [], "errors": [], "unchanged": 0,
                  "classified": {}, "requests": 0, "sitemap_ok": False}
        stamp = self.now().isoformat(timespec="seconds")

        urls: list[str] = []
        if discover:
            try:
                urls = sitemap_urls(self._get(SITEMAP_URL))
                report["sitemap_ok"] = bool(urls)
            except scraper.ScrapeError as exc:
                report["errors"].append(f"sitemap : {exc}")
        self.log(f"{len(urls)} pages de formation dans le sitemap")

        todo = []
        for url in urls:
            page = self.pages.get(page_key(url))
            if page:
                page["last_seen"] = stamp
            if page is None or page["kind"] in REREAD:
                todo.append(url)
        if not discover:
            todo = [p["url"] for p in self.pages.values() if p["kind"] in REREAD]
        if limit is not None:
            todo = todo[:limit]

        seen_codes: set[str] = set()
        for n, url in enumerate(todo, start=1):
            key = page_key(url)
            known = self.pages.get(key)
            if n % 50 == 0:
                self.log(f"… {n}/{len(todo)} pages lues")
            try:
                html = self._get(url)
            except scraper.ScrapeError as exc:
                report["errors"].append(f"{url} : {exc}")
                if known and known.get("code"):
                    seen_codes.add(known["code"])  # une panne ne doit pas retirer un diplôme
                continue
            kind, code = scraper.classify(html)
            self.pages[key] = {
                "url": url, "kind": kind, "code": code,
                "first_seen": known["first_seen"] if known else stamp, "last_seen": stamp, "checked_at": stamp,
            }
            report["classified"][kind] = report["classified"].get(kind, 0) + 1
            if kind != "diplome":
                if kind == "sans-programme":
                    seen_codes.add(code)
                continue
            seen_codes.add(code)
            try:
                result = self.catalog.import_program(scraper.parse_program(html, url), self.now(), source="sitemap")
            except scraper.ScrapeError as exc:
                report["errors"].append(f"{url} : {exc}")
                continue
            if result.created and result.previous:
                report["versions"].append(f"{result.title} ({result.version})")
            elif result.created:
                report["new"].append(f"{result.title} ({result.code})")
            else:
                report["unchanged"] += 1

        # Diplômes ajoutés par une demande et absents du sitemap : relus par leur adresse.
        for entry in list(self.catalog.diplomas):
            if entry.get("source") == "sitemap" or entry.get("code") in seen_codes or limit is not None:
                continue
            try:
                result = self.catalog.import_program(scraper.parse_program(self._get(entry["url"]), entry["url"]), self.now())
            except scraper.ScrapeError as exc:
                report["errors"].append(f"{entry['url']} : {exc}")
                continue
            if result.created:
                report["versions"].append(f"{result.title} ({result.version})")
            else:
                report["unchanged"] += 1

        # Retraits : seulement si le sitemap a été lu en entier.
        if report["sitemap_ok"] and limit is None:
            for entry in self.catalog.diplomas:
                if entry.get("source") != "sitemap":
                    continue
                present = entry.get("code") in seen_codes
                if present and entry.get("retired"):
                    entry["retired"] = False
                    entry.pop("retired_at", None)
                    report["restored"].append(entry["title"])
                elif not present and not entry.get("retired"):
                    entry["retired"] = True
                    entry["retired_at"] = stamp
                    report["retired"].append(entry["title"])

        report["requests"] = self._requests
        self.catalog.save()
        self.save()
        return report


def summary(report: dict, catalog: Catalog) -> str:
    active = sum(1 for d in catalog.diplomas if not d.get("retired"))
    lines = [
        f"**{active} diplômes proposés** ({len(catalog.diplomas)} au catalogue), {report['requests']} requêtes vers le site du Cnam.",
        "",
        f"- Nouveaux diplômes : {len(report['new'])}",
        f"- Nouvelles versions de maquette : {len(report['versions'])}",
        f"- Programmes inchangés : {report['unchanged']}",
        f"- Formations retirées du site : {len(report['retired'])}, revenues : {len(report['restored'])}",
        f"- Erreurs : {len(report['errors'])}",
    ]
    if report["classified"]:
        lines.append(f"- Pages classées : {', '.join(f'{k} {v}' for k, v in sorted(report['classified'].items()))}")
    for title, items in (("Nouveaux diplômes", report["new"]), ("Nouvelles versions", report["versions"]),
                         ("Retirés", report["retired"]), ("Erreurs", report["errors"])):
        if items:
            lines += ["", f"<details><summary>{title} ({len(items)})</summary>", "", *[f"- {x}" for x in items], "", "</details>"]
    return "\n".join(lines)
