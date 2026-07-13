from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]


def load_script(name: str):
    path = REPO / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


local_refs = load_script("check_local_refs")
allowlist = load_script("check_v227_allowlist")
team = load_script("check_team_dom")
aluminum = load_script("check_aluminum_sources")
public_claims = load_script("check_public_claims")


class LocalReferenceTests(unittest.TestCase):
    def test_validates_files_and_fragments(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "style.css").write_text(".hero{background:url('img/a.jpg')}", encoding="utf-8")
            (root / "img").mkdir()
            (root / "img/a.jpg").write_bytes(b"jpeg")
            (root / "child").mkdir()
            (root / "child/index.html").write_text('<main id="target"></main>', encoding="utf-8")
            (root / "index.html").write_text(
                '<link rel="stylesheet" href="style.css"><a href="child/#target">ok</a>',
                encoding="utf-8",
            )
            count, errors = local_refs.validate(root)
            self.assertGreaterEqual(count, 3)
            self.assertEqual(errors, [])

    def test_reports_missing_file_and_fragment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "index.html").write_text(
                '<main id="top"></main><a href="#missing">bad</a><img src="missing.jpg">',
                encoding="utf-8",
            )
            _count, errors = local_refs.validate(root)
            self.assertTrue(any("missing fragment" in error for error in errors))
            self.assertTrue(any("missing local target" in error for error in errors))


class AllowlistTests(unittest.TestCase):
    def test_allowed_dom_subtree_is_removed_before_comparison(self) -> None:
        matchers = [{"tag": "section", "id": "team"}]
        baseline = '<main><section id="team"><p>old</p></section><p>protected</p></main>'
        changed = '<main><section id="team"><p>new</p></section><p>protected</p></main>'
        self.assertEqual(
            allowlist.normalize_html(baseline, matchers),
            allowlist.normalize_html(changed, matchers),
        )

    def test_protected_dom_change_is_detected(self) -> None:
        matchers = [{"tag": "section", "id": "team"}]
        baseline = '<main><section id="team"></section><p>protected</p></main>'
        changed = '<main><section id="team"></section><p>changed</p></main>'
        self.assertNotEqual(
            allowlist.normalize_html(baseline, matchers),
            allowlist.normalize_html(changed, matchers),
        )

    def test_css_policy_allows_only_scoped_selectors(self) -> None:
        policy = {"allowed_class_prefixes": ["team", "schueco-"], "allowed_ids": []}
        baseline = ".site-header { top: 10px; } .team { color: black; }"
        allowed_change = ".site-header { top: 10px; } .team { color: white; }"
        protected_change = ".site-header { top: 20px; } .team { color: black; }"
        self.assertEqual(
            allowlist.protected_css_rules(baseline, policy),
            allowlist.protected_css_rules(allowed_change, policy),
        )
        self.assertNotEqual(
            allowlist.protected_css_rules(baseline, policy),
            allowlist.protected_css_rules(protected_change, policy),
        )

    def test_path_globs_do_not_match_unrelated_cleanup(self) -> None:
        patterns = ["admin-app/**", "scripts/check_*.py"]
        self.assertTrue(allowlist.path_matches("admin-app/src/auth/login.js", patterns))
        self.assertFalse(allowlist.path_matches("pvc/index.html", patterns))


class TeamReleaseTests(unittest.TestCase):
    def test_current_team_release_matches_dom_and_evidence(self) -> None:
        errors = team.validate(
            REPO / "index.html",
            REPO / "release-evidence/team-release-evidence.json",
            REPO,
        )
        self.assertEqual(errors, [])

    def test_wrong_zhalnin_role_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            index = Path(directory) / "index.html"
            index.write_text(
                (REPO / "index.html").read_text(encoding="utf-8").replace(
                    "Операционный директор",
                    "Генеральный директор",
                    1,
                ),
                encoding="utf-8",
            )
            errors = team.validate(
                index,
                REPO / "release-evidence/team-release-evidence.json",
                REPO,
            )
            self.assertTrue(any("legacy role" in error or "wrong role" in error for error in errors))

    def test_tampered_output_hash_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            evidence = json.loads(
                (REPO / "release-evidence/team-release-evidence.json").read_text(encoding="utf-8")
            )
            evidence["portraits"][0]["outputs"]["webp"]["sha256"] = "0" * 64
            evidence_path = Path(directory) / "evidence.json"
            evidence_path.write_text(json.dumps(evidence, ensure_ascii=False), encoding="utf-8")
            errors = team.validate(REPO / "index.html", evidence_path, REPO)
            self.assertTrue(any("hash mismatch" in error for error in errors))


class AluminumReleaseTests(unittest.TestCase):
    def test_current_aluminum_claims_and_materials_are_valid(self) -> None:
        errors = aluminum.validate(
            REPO / "ALUMINUM_SOURCES.md",
            REPO / "aluminum/index.html",
            REPO,
        )
        self.assertEqual(errors, [])

    def test_generalized_drainage_claim_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            html = Path(directory) / "index.html"
            html.write_text(
                (REPO / "aluminum/index.html").read_text(encoding="utf-8").replace(
                    "</main>",
                    "<p>Скрытый дренаж есть у всех фасадов.</p></main>",
                ),
                encoding="utf-8",
            )
            errors = aluminum.validate(REPO / "ALUMINUM_SOURCES.md", html, REPO)
            self.assertTrue(any("drainage" in error for error in errors))

    def test_undocumented_claim_id_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            sources = Path(directory) / "ALUMINUM_SOURCES.md"
            sources.write_text(
                (REPO / "ALUMINUM_SOURCES.md").read_text(encoding="utf-8").replace(
                    '"id": "schueco-fws50"',
                    '"id": "undocumented-fws50"',
                    1,
                ),
                encoding="utf-8",
            )
            errors = aluminum.validate(sources, REPO / "aluminum/index.html", REPO)
            self.assertTrue(any("undocumented claim ids" in error for error in errors))

    def test_current_public_claims_are_safe(self) -> None:
        self.assertEqual(public_claims.validate(REPO), [])

    def test_unverified_schueco_relationship_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "aluminum").mkdir()
            (root / "aluminum/index.html").write_text(
                '<main data-claim-scope="aws-75-pd-si">Schüco — официальный дилер. Скрытый дренаж AWS 75 PD.SI.</main>',
                encoding="utf-8",
            )
            errors = public_claims.validate(root)
            self.assertTrue(any("relationship" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
