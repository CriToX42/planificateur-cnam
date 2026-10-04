from datetime import datetime
from pathlib import Path

import pytest

from cnam import scraper
from cnam.catalog import Catalog
from cnam.crawl import SITEMAP_URL, Crawler, sitemap_urls

FIXTURES = Path(__file__).parent / "fixtures"
BASE = "https://www.cnam-paris.fr/choisir-ma-formation/par-discipline/"
CYBER = BASE + "diplome-d-ingenieur-specialite-informatique-parcours-cybersecurite-1608276.kjsp"
DPO = BASE + "certificat-de-specialisation-delegue-a-la-protection-des-donnees-dpo--1486747.kjsp"
UE = BASE + "algorithmique-de-la-bio-informatique-1487115.kjsp"
UE_HTML = "<html><h1>Algorithmique</h1><p>Code UE : BNF103-PAR</p></html>"


def sitemap(*urls):
    body = "".join(f"<url><loc>{u}</loc><lastmod>2026-10-03T00:00:00+02:00</lastmod></url>" for u in urls)
    return f'<?xml version="1.0"?><urlset>{body}<url><loc>https://www.cnam-paris.fr/agenda-1.kjsp</loc></url></urlset>'


class FakeSite:
    def __init__(self):
        self.pages = {
            CYBER: (FIXTURES / "ingenieur_cyber.html").read_text(encoding="utf-8"),
            DPO: (FIXTURES / "certificat_dpo.html").read_text(encoding="utf-8"),
            UE: UE_HTML,
        }
        self.listed = [CYBER, DPO, UE]
        self.calls = []
        self.down = False

    def __call__(self, url):
        self.calls.append(url)
        if url == SITEMAP_URL:
            if self.down:
                raise scraper.ScrapeError("Le site du Cnam a répondu 503 pour cette adresse.")
            return sitemap(*self.listed)
        return self.pages[url]


@pytest.fixture
def site():
    return FakeSite()


def crawl(tmp_path, site, day):
    catalog = Catalog(tmp_path / "data")
    report = Crawler(catalog, tmp_path / "index.json", fetch=site, delay=0, now=lambda: datetime(2026, 10, day, 7), log=lambda m: None).run()
    return Catalog(tmp_path / "data"), report


def test_sitemap_keeps_only_formation_pages():
    assert sitemap_urls(sitemap(CYBER, UE)) == sorted([CYBER, UE])


def test_first_pass_classifies_and_imports(tmp_path, site):
    catalog, report = crawl(tmp_path, site, 5)
    assert sorted(d["id"] for d in catalog.diplomas) == ["CS5200A-PAR", "CYC9106A-PAR"]
    assert report["classified"] == {"diplome": 2, "ue": 1}
    dpo = next(d for d in catalog.diplomas if d["id"] == "CS5200A-PAR")
    assert (dpo["type"], dpo["source"], dpo["retired"]) == ("Certificat", "sitemap", False)


def test_second_pass_rereads_diplomas_but_not_ue(tmp_path, site):
    crawl(tmp_path, site, 5)
    site.calls.clear()
    site.pages[CYBER] = site.pages[CYBER].replace("UTC503", "UTC599")
    catalog, report = crawl(tmp_path, site, 12)
    assert UE not in site.calls and CYBER in site.calls and DPO in site.calls
    assert report["versions"] == ["Diplôme d'ingénieur Spécialité informatique Parcours Cybersécurité (20261012)"]
    assert report["unchanged"] == 1


def test_retired_then_restored_and_moved_url(tmp_path, site):
    crawl(tmp_path, site, 5)
    site.listed = [CYBER, UE]
    catalog, report = crawl(tmp_path, site, 12)
    assert report["retired"] and next(d for d in catalog.diplomas if d["id"] == "CS5200A-PAR")["retired"]

    moved = BASE + "nouvelle-adresse-dpo-9999999.kjsp"
    site.pages[moved] = site.pages[DPO]
    site.listed = [CYBER, UE, moved]
    catalog, report = crawl(tmp_path, site, 19)
    dpo = next(d for d in catalog.diplomas if d["id"] == "CS5200A-PAR")
    assert (dpo["retired"], dpo["url"], len(dpo["versions"])) == (False, moved, 1)
    assert report["restored"] == [dpo["title"]]


def test_sitemap_outage_never_retires(tmp_path, site):
    crawl(tmp_path, site, 5)
    site.down = True
    catalog, report = crawl(tmp_path, site, 12)
    assert not report["sitemap_ok"] and report["errors"]
    assert not any(d["retired"] for d in catalog.diplomas)
