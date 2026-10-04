"""Téléchargement et analyse d'une fiche diplôme du Cnam Paris.

La page contient le programme dans un bloc `div.schema` rendu côté serveur :

    div.bloc-annuel            une année du programme (libellé optionnel)
      div.segment              linéaire, ou `segment-alternatives` (parcours au choix)
        div.alternative        une branche du segment
          div.suite            suite de blocs à plat : séquence d'UE, invite de choix, choix

Les regroupements « Blocs fondamentaux, 4 UE dans au moins 3 domaines » ne sont pas
imbriqués dans le HTML : une invite sans UE suivie d'une autre invite est un groupe parent,
et ses sous-groupes s'enchaînent jusqu'à la prochaine séquence d'UE obligatoires.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx
from bs4 import BeautifulSoup, Tag

ALLOWED_HOST_SUFFIXES = ("cnam-paris.fr", "cnam.fr")
BASE_URL = "https://www.cnam-paris.fr"
REPO = os.environ.get("GITHUB_REPOSITORY", "CriToX42/planificateur-cnam")
USER_AGENT = f"Mozilla/5.0 (compatible; planificateur-cnam/0.3; +https://github.com/{REPO})"

# Type de formation déduit du début de l'intitulé, dans l'ordre (le plus précis d'abord).
DIPLOMA_TYPES = [
    (r"^licence professionnelle", "Licence professionnelle"),
    (r"^licence", "Licence"),
    (r"^mast[eè]re", "Mastère spécialisé"),
    (r"^master", "Master"),
    (r"^deust", "DEUST"),
    (r"^doctorat", "Doctorat"),
    (r"^dipl[ôo]me d'ing[ée]nieur", "Diplôme d'ingénieur"),
    (r"^titre rncp|^titre ", "Titre RNCP"),
    (r"^certificat|^certification", "Certificat"),
    (r"^bachelor", "Bachelor"),
    (r"^dipl[ôo]me|^dpct|^dut|^but", "Diplôme d'établissement"),
]

SEMESTER_PREFIXES = {
    "1er semestre": ["S1"],
    "2nd semestre": ["S2"],
    "1er et 2nd semestre": ["S1", "S2"],
    "annuel": ["A"],
}

NUMBER_WORDS = {"un": 1, "une": 1, "deux": 2, "trois": 3, "quatre": 4, "cinq": 5, "six": 6}
_NUM = r"(\d+|un|une|deux|trois|quatre|cinq|six)"


class ScrapeError(Exception):
    """Erreur présentable à l'utilisateur."""


def normalize_url(url: str) -> str:
    url = url.strip()
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ScrapeError("L'adresse doit commencer par https:// et pointer vers une fiche diplôme.")
    host = parts.hostname or ""
    if not any(host == s or host.endswith("." + s) for s in ALLOWED_HOST_SUFFIXES):
        raise ScrapeError("Seules les fiches diplôme du Cnam (cnam-paris.fr, cnam.fr) sont acceptées.")
    return urlunsplit(("https", parts.netloc, parts.path, parts.query, ""))


def diploma_key(url: str) -> str:
    """Identifiant stable d'une fiche, indépendant des paramètres de suivi (RF=, RH=)."""
    parts = urlsplit(url)
    m = re.search(r"-(\d+)\.kjsp$", parts.path)
    if m:
        return f"{parts.hostname}:{m.group(1)}"
    return f"{parts.hostname}:{parts.path}"


def fetch(url: str) -> str:
    try:
        resp = httpx.get(url, headers={"User-Agent": USER_AGENT}, follow_redirects=True, timeout=25)
    except httpx.HTTPError as exc:
        raise ScrapeError(f"Impossible de joindre le site du Cnam ({exc.__class__.__name__}).") from exc
    if resp.status_code != 200:
        raise ScrapeError(f"Le site du Cnam a répondu {resp.status_code} pour cette adresse.")
    return resp.text


def _text(el: Tag | None, sep: str = " ") -> str:
    return el.get_text(sep, strip=True) if el else ""


def _to_int(word: str) -> int:
    return int(word) if word.isdigit() else NUMBER_WORDS[word]


def parse_rule(label: str, total_text: str) -> dict:
    """Extrait les contraintes vérifiables d'une consigne de choix."""
    low = label.lower()
    rule: dict = {"ue_count": None, "credits": None, "min_domains": None, "total_ects": None}
    if m := re.search(_NUM + r"\s+ue\b", low):
        rule["ue_count"] = _to_int(m.group(1))
    if m := re.search(r"(\d+)\s+cr[ée]dits?", low):
        rule["credits"] = int(m.group(1))
    if m := re.search(r"au moins\s+" + _NUM + r"\s+domaines?", low):
        rule["min_domains"] = _to_int(m.group(1))
    if m := re.search(r"(\d+)", total_text):
        rule["total_ects"] = int(m.group(1))
    return rule


def parse_offer(lines: list[str]) -> tuple[dict[str, list[str]], list[str]]:
    """'1er semestre : Formation ouverte et à distance' -> {'S1': ['Formation ouverte et à distance']}."""
    offer: dict[str, list[str]] = {}
    unknown: list[str] = []
    for line in lines:
        prefix, _, rest = line.partition(":")
        sems = SEMESTER_PREFIXES.get(prefix.strip().lower())
        if not sems:
            unknown.append(line)
            continue
        modalities = [m.strip() for m in rest.split(",") if m.strip()]
        for sem in sems:
            bucket = offer.setdefault(sem, [])
            bucket.extend(m for m in modalities if m not in bucket)
    return offer, unknown


@dataclass
class _Builder:
    years: list[dict] = field(default_factory=list)
    groups: list[dict] = field(default_factory=list)
    items: list[dict] = field(default_factory=list)

    def add_group(self, **kw) -> dict:
        group = {"id": f"g{len(self.groups) + 1}", "items": [], "children": [], **kw}
        self.groups.append(group)
        if group.get("parent"):
            self.group(group["parent"])["children"].append(group["id"])
        return group

    def group(self, gid: str) -> dict:
        return next(g for g in self.groups if g["id"] == gid)

    def add_item(self, ue: Tag, year_id: str, group_id: str | None) -> None:
        link_el = ue.select_one(".titre a") or ue.select_one(".code a")
        link = link_el.get("data-url") if link_el else None
        credits = re.search(r"(\d+)", _text(ue.select_one(".credits")))
        offer, unknown = parse_offer([_text(li) for li in ue.select("ul.modalites li")])
        item = {
            "id": f"i{len(self.items) + 1}",
            "code": _text(ue.select_one(".code")),
            "title": _text(ue.select_one(".titre")),
            "ects": int(credits.group(1)) if credits else 0,
            "year": year_id,
            "group": group_id,
            "offer": offer,
            "offer_notes": unknown,
            "link": urljoin(BASE_URL, link) if link else None,
        }
        self.items.append(item)
        if group_id:
            self.group(group_id)["items"].append(item["id"])

    def new_choice_group(self, prompt: Tag, year_id: str, parent: str | None) -> dict:
        total_text = _text(prompt.select_one(".credits-equivalents"))
        label = _text(prompt)
        if total_text and label.startswith(total_text):
            label = label[len(total_text):].strip()
        label = label.rstrip(" :")
        return self.add_group(
            kind="choice", year=year_id, parent=parent, label=label,
            rule=parse_rule(label, total_text),
        )

    def parse_suites(self, suites: list[Tag], year_id: str, context: str | None) -> None:
        open_parent: dict | None = None
        pending: dict | None = None  # invite sans UE en attente de ses UE

        def promote_pending() -> None:
            nonlocal open_parent, pending
            if pending is not None:
                pending["kind"] = "parent"
                open_parent = pending
                pending = None

        for suite in suites:
            classes = suite.get("class", [])
            if "suite-libelle" in classes:
                continue
            prompt = suite.select_one("h3.choice-prompt")
            ues = suite.select("div.ue")

            if prompt is not None:
                if pending is not None:
                    promote_pending()
                parent_id = open_parent["id"] if open_parent else context
                group = self.new_choice_group(prompt, year_id, parent_id)
                if ues:
                    for ue in ues:
                        self.add_item(ue, year_id, group["id"])
                else:
                    pending = group
            elif ues:
                if pending is not None:
                    target = pending["id"]
                    pending = None
                elif "suite-choix" in classes:
                    parent_id = open_parent["id"] if open_parent else context
                    target = self.add_group(
                        kind="choice", year=year_id, parent=parent_id, label="Choix",
                        rule=parse_rule("", ""),
                    )["id"]
                else:
                    open_parent = None
                    target = context
                for ue in ues:
                    self.add_item(ue, year_id, target)


def _fix_c1(text: str) -> str:
    """Le site contient des caractères de contrôle C1 issus de cp1252 (U+009C au lieu de « œ »)."""
    return re.sub(r"[\x80-\x9f]", lambda m: bytes([ord(m.group())]).decode("cp1252", errors="ignore"), text)


def _year_label(raw: str) -> str:
    """« 1ere annee » -> « 1re année » ; les libellés comme « M1 » ou « L3 » restent tels quels."""
    label = re.sub(r"\bannee\b", "année", raw, flags=re.I)
    label = re.sub(r"\b1ere\b", "1re", label, flags=re.I)
    return re.sub(r"\b(\d+)eme\b", r"\1e", label, flags=re.I)


def diploma_type(title: str) -> str:
    low = title.strip().lower()
    return next((label for pattern, label in DIPLOMA_TYPES if re.search(pattern, low)), "Autre")


def _diploma_code(soup: BeautifulSoup) -> str | None:
    m = re.search(r"Code dipl[ôo]me/certificat\s*:\s*([A-Z0-9-]+)", soup.get_text(" "))
    return m.group(1) if m else None


def classify(html: str) -> tuple[str, str | None]:
    """Nature d'une page de formation : 'diplome', 'sans-programme', 'ue' ou 'autre', avec son code."""
    soup = BeautifulSoup(_fix_c1(html), "lxml")
    code = _diploma_code(soup)
    if code:
        has_program = bool(soup.select("div.schema div.ue"))
        return ("diplome" if has_program else "sans-programme"), code
    m = re.search(r"Code UE\s*:\s*([A-Z0-9-]+)", soup.get_text(" "))
    return ("ue", m.group(1)) if m else ("autre", None)


def parse_program(html: str, url: str) -> dict:
    soup = BeautifulSoup(_fix_c1(html), "lxml")
    schema = soup.select_one("div.schema")
    if schema is None or not schema.select("div.ue"):
        raise ScrapeError("Aucun programme trouvé sur cette page. Vérifie qu'il s'agit bien d'une fiche diplôme.")

    title = _text(soup.select_one("h1")) or "Diplôme sans titre"
    code = _diploma_code(soup)
    level_in = _text(soup.select_one(".encadre_contenu__niveau-entree")) or None
    level_out = _text(soup.select_one(".encadre_contenu__niveau-sortie")) or None
    badge = soup.select_one(".badge--credit")
    total_credits = int(_text(badge)) if badge and _text(badge).isdigit() else None

    b = _Builder()
    blocs = schema.select(":scope > div.bloc-annuel, :scope > div.bloc-annuel-annonyme") or [schema]
    for index, bloc in enumerate(blocs):
        year_id = f"y{index + 1}"
        label = _year_label(_text(bloc.select_one(".bloc-annuel-libelle"))) or ("Programme" if len(blocs) == 1 else f"Année {index + 1}")
        b.years.append({"id": year_id, "label": label})

        for segment in bloc.select(":scope > div.segment"):
            alternatives = segment.select(":scope > div.alternative")
            if len(alternatives) > 1:
                alt = b.add_group(
                    kind="alternative", year=year_id, parent=None,
                    label=f"{len(alternatives)} parcours possibles, 1 à choisir",
                    rule=parse_rule("", ""),
                )
                for n, branch_el in enumerate(alternatives, start=1):
                    name = _text(branch_el.select_one(".suite-libelle .prompt")) or f"Option {n}"
                    branch = b.add_group(kind="branch", year=year_id, parent=alt["id"], label=name, rule=parse_rule("", ""))
                    b.parse_suites(branch_el.select(":scope > div.suite"), year_id, branch["id"])
            else:
                for branch_el in alternatives:
                    b.parse_suites(branch_el.select(":scope > div.suite"), year_id, None)

    modalities: list[str] = []
    for item in b.items:
        for mods in item["offer"].values():
            modalities.extend(m for m in mods if m not in modalities)

    return {
        "title": title,
        "code": code,
        "total_credits": total_credits,
        "url": url,
        "years": b.years,
        "groups": b.groups,
        "items": b.items,
        "modalities": sorted(modalities),
        # Hors empreinte : ne doit pas créer de nouvelle version à lui seul.
        "meta": {"type": diploma_type(title), "level_in": level_in, "level_out": level_out},
    }


def content_hash(program: dict) -> str:
    stable = {k: v for k, v in program.items() if k not in ("url", "meta")}
    return hashlib.sha256(json.dumps(stable, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def scrape(url: str) -> dict:
    url = normalize_url(url)
    return parse_program(fetch(url), url)
