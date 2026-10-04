from pathlib import Path

import pytest

from cnam.scraper import ScrapeError, diploma_key, normalize_url, parse_offer, parse_program, parse_rule

FIXTURES = Path(__file__).parent / "fixtures"
CYBER_URL = "https://www.cnam-paris.fr/choisir-ma-formation/par-discipline/diplome-d-ingenieur-specialite-informatique-parcours-cybersecurite-1608276.kjsp?RF=1404475742767"


def load(name: str) -> dict:
    return parse_program((FIXTURES / f"{name}.html").read_text(encoding="utf-8"), "https://www.cnam-paris.fr/x")


def by_code(program: dict, code: str) -> dict:
    return next(i for i in program["items"] if i["code"] == code)


def test_cyber_metadata_and_years():
    p = load("ingenieur_cyber")
    assert p["title"] == "Diplôme d'ingénieur Spécialité informatique Parcours Cybersécurité"
    assert p["code"] == "CYC9106A-PAR"
    assert p["total_credits"] == 180
    assert [y["label"] for y in p["years"]] == ["1re année", "2e année", "3e année"]
    assert by_code(p, "CYB108")["title"].startswith("Durcissement et mise en œuvre")


def test_cyber_offers():
    p = load("ingenieur_cyber")
    assert by_code(p, "UTC501")["offer"] == {
        "S1": ["Formation en présentiel soir ou samedi"],
        "S2": ["Formation ouverte et à distance"],
    }
    assert set(by_code(p, "UTC502")["offer"]) == {"S1", "S2"}
    assert set(by_code(p, "UTC503")["offer"]) == {"S2"}
    assert set(by_code(p, "TED001")["offer"]) == {"A"}
    assert set(by_code(p, "ERG105")["offer"]) == {"S1", "A"}
    # Sans semestre : section « Autre »
    assert by_code(p, "UAEP05")["offer"] == {}
    assert by_code(p, "UAM91C")["ects"] == 30


def test_cyber_nested_choice_groups():
    p = load("ingenieur_cyber")
    groups = {g["id"]: g for g in p["groups"]}
    blocs = next(g for g in p["groups"] if g["label"].startswith("Blocs fondamentaux"))
    assert blocs["kind"] == "parent"
    assert blocs["rule"] == {"ue_count": 4, "credits": None, "min_domains": 3, "total_ects": 24}
    children = [groups[c]["label"].split(",")[0] for c in blocs["children"]]
    assert children == [f"Bloc fondamental {d}" for d in ("IAO", "AISL", "SIBI", "IRSM", "EI")]
    # ENG261 suit les blocs : il est obligatoire, pas dans le dernier bloc
    assert by_code(p, "ENG261")["group"] is None
    assert by_code(p, "NSY103")["group"] == blocs["children"][-1]

    shes = next(g for g in p["groups"] if g["label"].startswith("SHES"))
    assert shes["kind"] == "choice" and shes["parent"] is None
    assert shes["rule"]["credits"] == 6
    assert len(shes["items"]) == 29


def test_cyber_required_credits_add_up():
    p = load("ingenieur_cyber")
    required = sum(i["ects"] for i in p["items"] if i["group"] is None)
    top_groups = sum(g["rule"]["total_ects"] for g in p["groups"] if g["parent"] is None)
    assert required + top_groups == 180


def test_alternatives_become_branches():
    p = load("titre_rncp_alternatives")
    alt = next(g for g in p["groups"] if g["kind"] == "alternative")
    branches = [g for g in p["groups"] if g["parent"] == alt["id"]]
    assert [b["label"] for b in branches] == ["Parcours Mode", "Parcours Business unit Management", "Parcours Innovation Management"]
    assert all(b["kind"] == "branch" and len(b["items"]) == 5 for b in branches)


def test_anonymous_year_block():
    p = load("certificat_dpo")
    assert [y["label"] for y in p["years"]] == ["Programme"]
    assert [(i["code"], list(i["offer"])) for i in p["items"]] == [("DNT104", ["S1"]), ("DNT105", ["S2"]), ("DNT106", ["S2"])]


def test_credit_choice_groups():
    p = load("master_iot")
    assert [g["rule"]["credits"] for g in p["groups"]] == [12, 6, 6]


def test_parse_rule_words():
    assert parse_rule("une UE à choisir parmi :", "Total 6 ECTS")["ue_count"] == 1
    assert parse_rule("Une UE à choisir parmi", "")["ue_count"] == 1
    assert parse_rule("12 crédits à choisir parmi", "Total 12 : ECTS") == {"ue_count": None, "credits": 12, "min_domains": None, "total_ects": 12}


def test_parse_offer_multiple_modalities():
    offer, unknown = parse_offer(["1er et 2nd semestre : Formation à distance planifiée soir ou samedi, Formation hybride soir ou samedi", "Été : stage"])
    assert offer["S1"] == offer["S2"] == ["Formation à distance planifiée soir ou samedi", "Formation hybride soir ou samedi"]
    assert unknown == ["Été : stage"]


def test_url_rules():
    assert normalize_url(CYBER_URL + "#onglet2").endswith("?RF=1404475742767")
    assert diploma_key(CYBER_URL) == diploma_key(CYBER_URL.replace("RF=", "RH=")) == "www.cnam-paris.fr:1608276"
    with pytest.raises(ScrapeError):
        normalize_url("https://example.com/diplome-1.kjsp")
    with pytest.raises(ScrapeError):
        normalize_url("pas une url")


def test_page_without_program():
    with pytest.raises(ScrapeError):
        parse_program("<html><h1>Rien</h1></html>", "https://www.cnam-paris.fr/x")
