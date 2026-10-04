import json
from datetime import datetime
from pathlib import Path

import pytest

from cnam import __main__ as cli
from cnam import scraper
from cnam.catalog import Catalog, diploma_id

FIXTURES = Path(__file__).parent / "fixtures"
URL = "https://www.cnam-paris.fr/choisir-ma-formation/par-discipline/diplome-d-ingenieur-specialite-informatique-parcours-cybersecurite-1608276.kjsp?RF=1404475742767"


@pytest.fixture
def page(monkeypatch):
    html = {"page": (FIXTURES / "ingenieur_cyber.html").read_text(encoding="utf-8")}
    monkeypatch.setattr(scraper, "fetch", lambda url: html["page"])
    return html


def test_diploma_id():
    assert diploma_id(URL) == "1608276"
    assert len(diploma_id("https://www.cnam.fr/une-page-sans-numero")) == 12


def test_import_versions_and_dedupe(tmp_path, page):
    catalog = Catalog(tmp_path)
    first = catalog.import_url(URL, datetime(2026, 10, 4, 9))
    assert (first.diploma_id, first.version, first.created, first.previous) == ("1608276", "20261004", True, None)

    same = Catalog(tmp_path).import_url(URL.replace("RF=", "RH="), datetime(2026, 10, 11, 9))
    assert (same.version, same.created) == ("20261004", False)

    page["page"] = page["page"].replace("UTC503", "UTC599")
    changed = Catalog(tmp_path).import_url(URL, datetime(2026, 10, 11, 9))
    assert (changed.version, changed.created, changed.previous) == ("20261011", True, "20261004")

    page["page"] = page["page"].replace("UTC504", "UTC598")
    again = Catalog(tmp_path).import_url(URL, datetime(2026, 10, 11, 18))
    assert again.version == "20261011-2"

    data = json.loads((tmp_path / "catalog.json").read_text(encoding="utf-8"))
    entry = data["diplomas"][0]
    assert [v["version"] for v in entry["versions"]] == ["20261011-2", "20261011", "20261004"]
    assert entry["checked_at"] == "2026-10-11T18:00:00"
    maquette = json.loads((tmp_path / "maquettes" / "1608276" / "20261011-2.json").read_text(encoding="utf-8"))
    assert maquette["code"] == "CYC9106A-PAR"


def test_cli_import_from_issue_body(tmp_path, page, monkeypatch):
    out, comment = tmp_path / "out.txt", tmp_path / "comment.md"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setenv("GITHUB_REPOSITORY", "Jules/planificateur-cnam")
    monkeypatch.setenv("ISSUE_BODY", f"### Adresse de la fiche diplôme\n\n{URL}\n\n### Remarque\n\n_No response_")
    root = tmp_path / "data"

    assert cli.main(["--root", str(root), "import", "--issue-body-env", "ISSUE_BODY", "--comment", str(comment)]) == 0
    assert "ok=true\nchanged=true\ndiploma=1608276" in out.read_text()
    text = comment.read_text(encoding="utf-8")
    assert "https://jules.github.io/planificateur-cnam/#/nouveau/1608276" in text
    assert json.loads((root / "catalog.json").read_text(encoding="utf-8"))["repo"] == "Jules/planificateur-cnam"


def test_cli_import_rejects_foreign_url(tmp_path, monkeypatch):
    out, comment = tmp_path / "out.txt", tmp_path / "comment.md"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setenv("ISSUE_BODY", "https://example.com/diplome-12.kjsp")
    assert cli.main(["--root", str(tmp_path), "import", "--issue-body-env", "ISSUE_BODY", "--comment", str(comment)]) == 0
    assert "ok=false" in out.read_text()
    assert "Impossible d'importer" in comment.read_text(encoding="utf-8")


def test_cli_refresh(tmp_path, page, monkeypatch):
    summary = tmp_path / "summary.md"
    Catalog(tmp_path).import_url(URL, datetime(2026, 10, 4, 9))
    page["page"] = page["page"].replace("UTC503", "UTC599")
    assert cli.main(["--root", str(tmp_path), "refresh", "--summary", str(summary)]) == 0
    assert "nouvelle version" in summary.read_text(encoding="utf-8")
