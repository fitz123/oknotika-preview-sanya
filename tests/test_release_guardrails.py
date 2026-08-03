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
document_revision = load_script("check_document_revision")
homepage_proof = load_script("check_homepage_proof")
public_media = load_script("check_public_media_repetition")


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


class PublicMediaRepetitionTests(unittest.TestCase):
    def test_current_public_pages_use_each_visible_medium_once(self) -> None:
        self.assertEqual(public_media.validate(REPO), [])

    def test_repeated_image_and_inline_background_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            page = root / "index.html"
            page.write_text(
                '<img src="img/repeated.jpg"><article style="background-image: url(\'img/repeated.jpg\')"></article>',
                encoding="utf-8",
            )
            errors = public_media.validate_page(page, root)
            self.assertTrue(any("repeated local media img/repeated.jpg" in error for error in errors))

    def test_logo_and_picture_alternatives_are_excluded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            page = root / "index.html"
            page.write_text(
                '<img class="brand__logo" src="img/logo-oknotika.svg">'
                '<img class="brand__logo" src="img/logo-oknotika.svg">'
                '<picture><source srcset="img/photo.webp"><img src="img/photo.webp"></picture>',
                encoding="utf-8",
            )
            self.assertEqual(public_media.validate_page(page, root), [])

    def test_video_only_poster_is_allowed_but_standalone_reuse_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            page = root / "index.html"
            page.write_text('<video poster="img/poster.jpg"></video>', encoding="utf-8")
            self.assertEqual(public_media.validate_page(page, root), [])
            page.write_text(
                '<video poster="img/poster.jpg"></video><img src="img/poster.jpg">',
                encoding="utf-8",
            )
            errors = public_media.validate_page(page, root)
            self.assertTrue(any("repeated local media img/poster.jpg" in error for error in errors))


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

    def test_wrong_team_order_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            index = Path(directory) / "index.html"
            html = (REPO / "index.html").read_text(encoding="utf-8")
            html = html.replace("Алексей Макаров", "__TEAM_SWAP__")
            html = html.replace("Дмитрий Благочевский", "Алексей Макаров")
            html = html.replace("__TEAM_SWAP__", "Дмитрий Благочевский")
            index.write_text(html, encoding="utf-8")
            errors = team.validate(
                index,
                REPO / "release-evidence/team-release-evidence.json",
                REPO,
            )
            self.assertTrue(any("wrong team order" in error for error in errors))

    def test_team_layout_rejects_four_desktop_columns(self) -> None:
        css = (REPO / "style.css").read_text(encoding="utf-8").replace(
            ".team-grid { display: grid; grid-template-columns: repeat(3, 1fr);",
            ".team-grid { display: grid; grid-template-columns: repeat(4, 1fr);",
            1,
        )
        self.assertTrue(any("default to three columns" in error for error in team.validate_layout(css)))

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

    def test_premium_taxonomy_preserves_approved_systems(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            aluminum_path = Path(directory) / "aluminum.html"
            aluminum_path.write_text(
                (REPO / "aluminum/index.html").read_text(encoding="utf-8").replace(
                    "UNISTEM · Reynaers · Keller · ALUMIL",
                    "Reynaers · ALUPORT · Keller",
                    1,
                ),
                encoding="utf-8",
            )
            errors = aluminum.validate(REPO / "ALUMINUM_SOURCES.md", aluminum_path, REPO)
            self.assertTrue(any("taxonomy order changed" in error for error in errors))

    def test_legacy_scheme_caption_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            html = Path(directory) / "index.html"
            html.write_text(
                (REPO / "aluminum/index.html").read_text(encoding="utf-8").replace(
                    "</main>",
                    "<p>Авторская схема ОКНОТИКИ: не чертёж узла.</p></main>",
                ),
                encoding="utf-8",
            )
            errors = aluminum.validate(REPO / "ALUMINUM_SOURCES.md", html, REPO)
            self.assertTrue(any("legacy" in error for error in errors))

    def test_unapproved_raluma_photo_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            html = Path(directory) / "index.html"
            html.write_text(
                (REPO / "aluminum/index.html").read_text(encoding="utf-8").replace(
                    "raluma-portal-exterior.webp",
                    "raluma-unused-second.jpg",
                    1,
                ),
                encoding="utf-8",
            )
            errors = aluminum.validate(REPO / "ALUMINUM_SOURCES.md", html, REPO)
            self.assertTrue(any("unapproved visual" in error for error in errors))

    def test_raluma_loop_requires_muted_autoplay_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            html = Path(directory) / "index.html"
            html.write_text(
                (REPO / "aluminum/index.html").read_text(encoding="utf-8").replace(
                    "<video autoplay muted loop",
                    "<video autoplay loop",
                    1,
                ),
                encoding="utf-8",
            )
            errors = aluminum.validate(REPO / "ALUMINUM_SOURCES.md", html, REPO)
            self.assertTrue(any("video misses muted" in error for error in errors))

    def test_tampered_aluminum_media_hash_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            sources = Path(directory) / "ALUMINUM_SOURCES.md"
            sources.write_text(
                (REPO / "ALUMINUM_SOURCES.md").read_text(encoding="utf-8").replace(
                    '"sha256": "caf81c891fb97aa847a229b343f2114fd98ffcc2b7a3aa96fed6b36206494784"',
                    '"sha256": "' + "0" * 64 + '"',
                    1,
                ),
                encoding="utf-8",
            )
            errors = aluminum.validate(sources, REPO / "aluminum/index.html", REPO)
            self.assertTrue(any("material hash mismatch" in error for error in errors))

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

    def test_rejected_comparison_copy_is_not_public(self) -> None:
        rejected = {
            "15 000 ₽": "legacy public comparison price",
            "Саня и Антон": "personal public team naming",
            "Саня + Антон": "personal public team naming",
            "Быстро и безошибочно": "fast and error-free promise",
            "Покажем все различия": "complete-detection promise",
            "Выполним без автоматизации": "internal automation wording",
        }
        source = (REPO / "aluminum/index.html").read_text(encoding="utf-8")
        for phrase, label in rejected.items():
            with self.subTest(phrase=phrase), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "aluminum").mkdir()
                (root / "aluminum/index.html").write_text(
                    source.replace("</main>", f"<p>{phrase}</p></main>", 1),
                    encoding="utf-8",
                )
                errors = public_claims.validate(root)
                self.assertTrue(any(label in error for error in errors))


class DocumentRevisionTests(unittest.TestCase):
    def test_current_offer_and_presentation_are_valid(self) -> None:
        errors = document_revision.validate(
            REPO / "aluminum/index.html",
            REPO / "aluminum/document-revision-check/index.html",
        )
        self.assertEqual(errors, [])

    def test_teaser_replaces_the_final_aluminum_caveat(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            aluminum_path = Path(directory) / "aluminum.html"
            html = (REPO / "aluminum/index.html").read_text(encoding="utf-8")
            teaser_start = html.index('    <section class="section document-revision-teaser"')
            teaser_end = html.index("\n    </section>", teaser_start) + len("\n    </section>")
            teaser = html[teaser_start:teaser_end]
            html = html[:teaser_start] + html[teaser_end:]
            raluma_start = html.index('    <section class="section raluma-feature"')
            html = html[:raluma_start] + teaser + "\n\n" + html[raluma_start:]
            aluminum_path.write_text(html, encoding="utf-8")
            errors = document_revision.validate(
                aluminum_path,
                REPO / "aluminum/document-revision-check/index.html",
            )
            self.assertTrue(any("technology references before" in error for error in errors))

    def test_teaser_requires_safe_new_tab_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            aluminum_path = Path(directory) / "aluminum.html"
            aluminum_path.write_text(
                (REPO / "aluminum/index.html").read_text(encoding="utf-8").replace(
                    'href="document-revision-check/" target="_blank" rel="noopener noreferrer"',
                    'href="document-revision-check/" target="_blank"',
                    1,
                ),
                encoding="utf-8",
            )
            errors = document_revision.validate(
                aluminum_path,
                REPO / "aluminum/document-revision-check/index.html",
            )
            self.assertTrue(any("noopener noreferrer" in error for error in errors))

    def test_refund_boundary_cannot_be_broadened(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            presentation_path = Path(directory) / "presentation.html"
            presentation_path.write_text(
                (REPO / "aluminum/document-revision-check/index.html").read_text(encoding="utf-8").replace(
                    "только при подтверждённой фактической ошибке",
                    "при любом несогласии",
                    1,
                ),
                encoding="utf-8",
            )
            errors = document_revision.validate(REPO / "aluminum/index.html", presentation_path)
            self.assertTrue(any("refund boundary" in error for error in errors))

    def test_unsafe_accuracy_claim_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            presentation_path = Path(directory) / "presentation.html"
            presentation_path.write_text(
                (REPO / "aluminum/document-revision-check/index.html").read_text(encoding="utf-8").replace(
                    "</main>",
                    "<p>Гарантированно найдём все ошибки и изменения.</p></main>",
                    1,
                ),
                encoding="utf-8",
            )
            errors = document_revision.validate(REPO / "aluminum/index.html", presentation_path)
            self.assertTrue(any("perfect detection" in error for error in errors))

    def test_confirmed_tariffs_cannot_be_changed_or_repeated(self) -> None:
        source = (REPO / "aluminum/document-revision-check/index.html").read_text(encoding="utf-8")
        variants = (
            source.replace("35 000 ₽", "34 000 ₽", 1),
            source.replace("</table>", "</table><table></table>", 1),
        )
        for html in variants:
            with self.subTest(), tempfile.TemporaryDirectory() as directory:
                presentation_path = Path(directory) / "presentation.html"
                presentation_path.write_text(html, encoding="utf-8")
                errors = document_revision.validate(REPO / "aluminum/index.html", presentation_path)
                self.assertTrue(any("tariff" in error for error in errors))

    def test_personal_team_naming_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            presentation_path = Path(directory) / "presentation.html"
            presentation_path.write_text(
                (REPO / "aluminum/document-revision-check/index.html").read_text(encoding="utf-8").replace(
                    "Команда ОКНОТИКИ",
                    "Саня + Антон",
                    1,
                ),
                encoding="utf-8",
            )
            errors = document_revision.validate(REPO / "aluminum/index.html", presentation_path)
            self.assertTrue(any("personal team naming" in error for error in errors))


class HomepageProofTests(unittest.TestCase):
    def test_current_homepage_proof_is_valid(self) -> None:
        errors = homepage_proof.validate(REPO / "index.html", REPO / "IMAGE_SOURCES.md")
        self.assertEqual(errors, [])

    def test_yandex_consent_does_not_reuse_legacy_cookie_acceptance(self) -> None:
        errors = homepage_proof.validate_consent_script(REPO / "script.js")
        self.assertEqual(errors, [])

        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "script.js"
            script.write_text(
                (REPO / "script.js").read_text(encoding="utf-8").replace(
                    homepage_proof.YANDEX_CONSENT_KEY,
                    homepage_proof.LEGACY_COOKIE_KEY,
                ),
                encoding="utf-8",
            )
            errors = homepage_proof.validate_consent_script(script)
            self.assertTrue(any("legacy generic cookie consent" in error for error in errors))

    def test_glass_card_rejects_the_legacy_svg(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            homepage = Path(directory) / "index.html"
            homepage.write_text(
                (REPO / "index.html").read_text(encoding="utf-8").replace(
                    "img/product-world/glass-art.jpg",
                    "img/products/glass.svg",
                    1,
                ),
                encoding="utf-8",
            )
            errors = homepage_proof.validate(homepage, REPO / "IMAGE_SOURCES.md")
            self.assertTrue(any("licensed glass photograph" in error for error in errors))

    def test_rubikon_copy_outside_cases_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            homepage = Path(directory) / "index.html"
            homepage.write_text(
                (REPO / "index.html").read_text(encoding="utf-8").replace(
                    "</main>",
                    "<p>Компания Рубикон и Лункаш.</p></main>",
                    1,
                ),
                encoding="utf-8",
            )
            errors = homepage_proof.validate(homepage, REPO / "IMAGE_SOURCES.md")
            self.assertTrue(any("bounded to the cases" in error for error in errors))

    def test_homepage_cases_require_correct_order_scope_copy_and_hero(self) -> None:
        current = (REPO / "index.html").read_text(encoding="utf-8")
        proof_start = current.index('        <aside class="cases-partner reveal" data-rubikon-proof>')
        proof_end = current.index("\n        </aside>", proof_start) + len("\n        </aside>")
        grid_start = current.index('        <div class="case-grid">', proof_end)
        grid_end = current.index("\n        </div>", grid_start) + len("\n        </div>")
        proof = current[proof_start:proof_end]
        grid = current[grid_start:grid_end]

        invalid_pages = {
            "legacy hero": current.replace("img/cases/atrium.jpg", "img/cases/botanical-garden.jpg", 1),
            "generic portfolio": current.replace(
                "объекты ОКНОТИКИ и её партнёрской сети",
                "объекты разных типов",
                1,
            ),
            "proof after grid": current[:proof_start] + grid + "\n" + proof + current[grid_end:],
            "defensive disclaimer": current.replace(
                "ОКНОТИКА особенно ценит эту команду",
                "Самостоятельные объекты «Рубикона» не приписываются ОКНОТИКЕ. ОКНОТИКА особенно ценит эту команду",
                1,
            ),
            "attributed caption": current.replace(
                "Светопрозрачная кровля сложной геометрии.",
                "Работа компании «Рубикон».",
                1,
            ),
        }

        for label, source in invalid_pages.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                homepage = Path(directory) / "index.html"
                homepage.write_text(source, encoding="utf-8")
                errors = homepage_proof.validate(homepage, REPO / "IMAGE_SOURCES.md")
                self.assertTrue(errors, f"mutation was not rejected: {label}")

    def test_yandex_embeds_require_lazy_loading_and_exact_organization(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            homepage = Path(directory) / "index.html"
            homepage.write_text(
                (REPO / "index.html").read_text(encoding="utf-8")
                .replace(' loading="lazy" data-yandex-reviews', ' data-yandex-reviews', 1)
                .replace("122138017646?comments", "999?comments", 1),
                encoding="utf-8",
            )
            errors = homepage_proof.validate(homepage, REPO / "IMAGE_SOURCES.md")
            self.assertTrue(any("exact official" in error for error in errors))
            self.assertTrue(any("lazy-loaded" in error for error in errors))

    def test_yandex_embeds_wait_for_cookie_consent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            homepage = Path(directory) / "index.html"
            homepage.write_text(
                (REPO / "index.html").read_text(encoding="utf-8").replace(
                    "<iframe data-cookie-src=",
                    '<iframe src="https://yandex.ru/" data-cookie-src=',
                    1,
                ).replace(" data-cookie-decline", "", 1),
                encoding="utf-8",
            )
            errors = homepage_proof.validate(homepage, REPO / "IMAGE_SOURCES.md")
            self.assertTrue(any("before cookie consent" in error for error in errors))
            self.assertTrue(any("decline control" in error for error in errors))

    def test_yandex_proof_rejects_hardcoded_rating(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            homepage = Path(directory) / "index.html"
            homepage.write_text(
                (REPO / "index.html").read_text(encoding="utf-8").replace(
                    "После вашего согласия отзывы загружаются напрямую с Яндекс Карт",
                    "Рейтинг 5.0 · 100 отзывов",
                    1,
                ),
                encoding="utf-8",
            )
            errors = homepage_proof.validate(homepage, REPO / "IMAGE_SOURCES.md")
            self.assertTrue(any("hardcode" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
