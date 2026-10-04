"""Catalogue des diplômes publiés avec le site statique.

    site/data/catalog.json                      diplômes connus et leurs versions (la plus récente d'abord)
    site/data/maquettes/<id>/<version>.json     programme tel que lu sur la fiche, à cette date

Une nouvelle version n'est créée que si le programme diffère de la dernière version publiée.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from . import scraper

DATA_DIR = Path(__file__).resolve().parent.parent / "site" / "data"


def diploma_id(url: str) -> str:
    """Identifiant court et stable, utilisable dans un chemin de fichier et une URL."""
    parts = urlsplit(url)
    if m := re.search(r"-(\d+)\.kjsp$", parts.path):
        return m.group(1)
    return hashlib.sha1(scraper.diploma_key(url).encode()).hexdigest()[:12]


@dataclass
class ImportResult:
    diploma_id: str
    title: str
    code: str | None
    version: str
    created: bool
    previous: str | None


class Catalog:
    def __init__(self, root: Path = DATA_DIR):
        self.root = root
        self.path = root / "catalog.json"
        if self.path.exists():
            self.data = json.loads(self.path.read_text(encoding="utf-8"))
        else:
            self.data = {"repo": None, "diplomas": []}

    @property
    def diplomas(self) -> list[dict]:
        return self.data["diplomas"]

    def find(self, key: str) -> dict | None:
        return next((d for d in self.diplomas if d["key"] == key), None)

    def maquette_path(self, diploma: str, version: str) -> Path:
        return self.root / "maquettes" / diploma / f"{version}.json"

    def load_maquette(self, diploma: str, version: str) -> dict:
        return json.loads(self.maquette_path(diploma, version).read_text(encoding="utf-8"))

    def save(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.diplomas.sort(key=lambda d: d["title"].lower())
        self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    def add_version(self, program: dict, version: str, fetched_at: str, content_hash: str) -> dict:
        """Écrit la maquette et l'ajoute en tête des versions du diplôme (créé si besoin)."""
        key = scraper.diploma_key(program["url"])
        entry = self.find(key)
        if entry is None:
            entry = {"id": diploma_id(program["url"]), "key": key, "versions": []}
            self.diplomas.append(entry)
        entry.update(
            url=program["url"], title=program["title"], code=program["code"],
            total_credits=program["total_credits"], checked_at=fetched_at,
        )
        path = self.maquette_path(entry["id"], version)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(program, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        entry["versions"].insert(0, {"version": version, "fetched_at": fetched_at, "hash": content_hash})
        return entry

    def import_program(self, program: dict, now: datetime) -> ImportResult:
        key = scraper.diploma_key(program["url"])
        content_hash = scraper.content_hash(program)
        fetched_at = now.isoformat(timespec="seconds")
        entry = self.find(key)
        latest = entry["versions"][0] if entry and entry["versions"] else None

        if latest and latest["hash"] == content_hash:
            entry.update(url=program["url"], title=program["title"], code=program["code"], checked_at=fetched_at)
            self.save()
            return ImportResult(entry["id"], entry["title"], entry["code"], latest["version"], False, latest["version"])

        base = now.strftime("%Y%m%d")
        taken = {v["version"] for v in entry["versions"]} if entry else set()
        version, n = base, 2
        while version in taken:
            version, n = f"{base}-{n}", n + 1
        entry = self.add_version(program, version, fetched_at, content_hash)
        self.save()
        return ImportResult(entry["id"], entry["title"], entry["code"], version, True, latest["version"] if latest else None)

    def import_url(self, url: str, now: datetime) -> ImportResult:
        return self.import_program(scraper.scrape(url), now)
