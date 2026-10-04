"""Catalogue des diplômes publiés avec le site statique.

    site/data/catalog.json                      diplômes connus et leurs versions (la plus récente d'abord)
    site/data/maquettes/<code>/<version>.json   programme tel que lu sur la fiche, à cette date

Un diplôme est identifié par son code (CYC9106A-PAR) : son adresse sur le site du Cnam peut changer.
Une nouvelle version n'est créée que si le programme diffère de la dernière version publiée.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from . import scraper

DATA_DIR = Path(__file__).resolve().parent.parent / "site" / "data"


def diploma_id(program: dict) -> str:
    """Le code du diplôme ; à défaut, un identifiant tiré de l'adresse de la fiche."""
    if program.get("code"):
        return re.sub(r"[^A-Za-z0-9-]", "", program["code"])
    if m := re.search(r"-(\d+)\.kjsp$", urlsplit(program["url"]).path):
        return f"page-{m.group(1)}"
    return "page-" + hashlib.sha1(scraper.diploma_key(program["url"]).encode()).hexdigest()[:12]


def has_semesters(program: dict) -> bool:
    return any(item["offer"] for item in program["items"])


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
        self._use_codes_as_ids()

    def _use_codes_as_ids(self) -> None:
        """Anciennes entrées identifiées par le numéro de page : passage au code, l'ancien id devient un alias."""
        for entry in self.diplomas:
            if not entry.get("code"):
                continue
            wanted = diploma_id({"code": entry["code"], "url": entry["url"]})
            if entry["id"] == wanted:
                continue
            old_dir, new_dir = self.root / "maquettes" / entry["id"], self.root / "maquettes" / wanted
            if old_dir.exists() and not new_dir.exists():
                shutil.move(old_dir, new_dir)
            entry.setdefault("aliases", [])
            if entry["id"] not in entry["aliases"]:
                entry["aliases"].append(entry["id"])
            entry["id"] = wanted

    @property
    def diplomas(self) -> list[dict]:
        return self.data["diplomas"]

    def find(self, program: dict) -> dict | None:
        code = program.get("code")
        key = scraper.diploma_key(program["url"])
        return (next((d for d in self.diplomas if code and d.get("code") == code), None)
                or next((d for d in self.diplomas if d.get("key") == key), None))

    def maquette_path(self, diploma: str, version: str) -> Path:
        return self.root / "maquettes" / diploma / f"{version}.json"

    def save(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.diplomas.sort(key=lambda d: d["title"].lower())
        self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    def _describe(self, entry: dict, program: dict, checked_at: str) -> None:
        meta = program.get("meta") or {}
        entry.update(
            url=program["url"],
            key=scraper.diploma_key(program["url"]),
            title=program["title"],
            code=program["code"],
            total_credits=program["total_credits"],
            type=meta.get("type") or scraper.diploma_type(program["title"]),
            level_in=meta.get("level_in"),
            level_out=meta.get("level_out"),
            has_semesters=has_semesters(program),
            checked_at=checked_at,
        )

    def add_version(self, program: dict, version: str, fetched_at: str, content_hash: str, source: str = "demande") -> dict:
        """Écrit la maquette et l'ajoute en tête des versions du diplôme (créé si besoin)."""
        entry = self.find(program)
        if entry is None:
            entry = {"id": diploma_id(program), "aliases": [], "source": source, "retired": False, "versions": []}
            self.diplomas.append(entry)
        self._describe(entry, program, fetched_at)
        path = self.maquette_path(entry["id"], version)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(program, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        entry["versions"].insert(0, {"version": version, "fetched_at": fetched_at, "hash": content_hash})
        return entry

    def import_program(self, program: dict, now: datetime, source: str = "demande") -> ImportResult:
        content_hash = scraper.content_hash(program)
        fetched_at = now.isoformat(timespec="seconds")
        entry = self.find(program)
        latest = entry["versions"][0] if entry and entry["versions"] else None
        if entry is not None and source == "sitemap":
            entry["source"] = "sitemap"

        if latest and latest["hash"] == content_hash:
            self._describe(entry, program, fetched_at)
            self.save()
            return ImportResult(entry["id"], entry["title"], entry["code"], latest["version"], False, latest["version"])

        base = now.strftime("%Y%m%d")
        taken = {v["version"] for v in entry["versions"]} if entry else set()
        version, n = base, 2
        while version in taken:
            version, n = f"{base}-{n}", n + 1
        entry = self.add_version(program, version, fetched_at, content_hash, source)
        self.save()
        return ImportResult(entry["id"], entry["title"], entry["code"], version, True, latest["version"] if latest else None)

    def import_url(self, url: str, now: datetime, source: str = "demande") -> ImportResult:
        return self.import_program(scraper.scrape(url), now, source)
