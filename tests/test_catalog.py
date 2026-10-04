import json
from datetime import datetime
from pathlib import Path

import pytest

from cnam import __main__ as cli
from cnam import scraper
from cnam.catalog import Catalog, diploma_id

FIXTURES = Path(__file__).parent / "fixtures"
URL = "https://www.cnam-paris.fr/choisir-ma-formation/par-discipline/diplome-d-ingenieur-specialite-informatique-parcours-cybersecurite-1608276.kjsp?RF=1404475742767"
CODE = "CYC9106A-PAR"


@pytest.fixture
def page(monkeypatch):
    html = {"page": (FIXTURES / "ingenieur_cyber.html").read_text(encoding="utf-8")}
    monkeypatch.setattr(scraper, "fetch", lambda url: html["page"])
    return html


def test_diploma_id_is_the_code():
    assert diploma_id({"code": CODE, "url": URL}) == CODE
    assert diploma_id({"code": None, "url": URL}) == "page-1608276"


def test_import_versions_and_dedupe(tmp_path, page):
    catalog = Catalog(tmp_path)
    first = catalog.import_url(URL, datetime(2026, 10, 4, 9))
    assert (first.diploma_id, first.version, first.created, first.previous) == (CODE, "20261004", True, None)

    same = Catalog(tmp_path).import_url(URL.replace("RF=", "RH="), datetime(2026, 10, 11, 9))
    assert (same.version, same.created) == ("20261004", False)

    page["page"] = page["page"].replace("UTC503", "UTC599")
    changed = Catalog(tmp_path).import_url(URL, datetime(2026, 10, 11, 9))
    assert (changed.version, changed.created, changed.previous) == ("20261011", True, "20261004")

    page["page"] = page["page"].replace("UTC504", "UTC598")
    assert Catalog(tmp_path).import_url(URL, datetime(2026, 10, 11, 18)).version == "20261011-2"

    entry = json.loads((tmp_path / "catalog.json").read_text(encoding="utf-8"))["diplomas"][0]
    assert [v["version"] for v in entry["versions"]] == ["20261011-2", "20261011", "20261004"]
    assert (entry["type"], entry["level_out"], entry["has_semesters"]) == ("Diplôme d'ingénieur", "Niveau 7 (Bac+5)", True)
    assert (tmp_path / "maquettes" / CODE / "20261011-2.json").exists()


def test_new_url_same_code_is_the_same_diploma(tmp_path, page):
    Catalog(tmp_path).import_url(URL, datetime(2026, 10, 4, 9))
    moved = "https://www.cnam-paris.fr/choisir-ma-formation/par-discipline/ingenieur-cybersecurite-2000001.kjsp"
    result = Catalog(tmp_path).import_url(moved, datetime(2026, 10, 11, 9))
    entries = json.loads((tmp_path / "catalog.json").read_text(encoding="utf-8"))["diplomas"]
    assert (len(entries), result.created, entries[0]["url"]) == (1, False, moved)


def test_old_numeric_ids_become_aliases(tmp_path, page):
    Catalog(tmp_path).import_url(URL, datetime(2026, 9, 30, 9))
    data = json.loads((tmp_path / "catalog.json").read_text(encoding="utf-8"))
    data["diplomas"][0]["id"] = "1608276"  # format d'avant
    (tmp_path / "maquettes" / CODE).rename(tmp_path / "maquettes" / "1608276")
    (tmp_path / "catalog.json").write_text(json.dumps(data), encoding="utf-8")

    catalog = Catalog(tmp_path)
    entry = catalog.diplomas[0]
    assert (entry["id"], entry["aliases"]) == (CODE, ["1608276"])
    assert (tmp_path / "maquettes" / CODE / "20260930.json").exists()


def test_cli_import_from_issue_body(tmp_path, page, monkeypatch):
    out, comment = tmp_path / "out.txt", tmp_path / "comment.md"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setenv("GITHUB_REPOSITORY", "Jules/planificateur-cnam")
    monkeypatch.setenv("ISSUE_BODY", f"### Adresse de la fiche diplôme\n\n{URL}\n\n### Remarque\n\n_No response_")
    root = tmp_path / "data"

    assert cli.main(["--root", str(root), "import", "--issue-body-env", "ISSUE_BODY", "--comment", str(comment)]) == 0
    assert f"ok=true\nchanged=true\ndiploma={CODE}" in out.read_text()
    assert f"https://jules.github.io/planificateur-cnam/#/nouveau/{CODE}" in comment.read_text(encoding="utf-8")
    assert json.loads((root / "catalog.json").read_text(encoding="utf-8"))["repo"] == "Jules/planificateur-cnam"


def test_cli_import_rejects_foreign_url(tmp_path, monkeypatch):
    out, comment = tmp_path / "out.txt", tmp_path / "comment.md"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setenv("ISSUE_BODY", "https://example.com/diplome-12.kjsp")
    assert cli.main(["--root", str(tmp_path), "import", "--issue-body-env", "ISSUE_BODY", "--comment", str(comment)]) == 0
    assert "ok=false" in out.read_text()
    assert "Impossible d'importer" in comment.read_text(encoding="utf-8")
