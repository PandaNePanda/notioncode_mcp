import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from model_catalog import BASE_MODEL_IDS, VerifiedModelCatalog


class FakeClient:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self._user_map_cache = {"stale": "value"}

    async def fetch_available_models(self):
        if self.error:
            raise self.error
        return self.response


def available(*pairs):
    return {
        "models": [
            item
            if isinstance(item, dict)
            else {"modelMessage": item[0], "model": item[1], "isDisabled": False}
            for item in pairs
        ]
    }


class VerifiedModelCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.base = Path(__file__).resolve().parents[2] / "config" / "codex-models.json"
        self.base_aliases = (
            Path(__file__).resolve().parents[2]
            / "state-template"
            / ".notionagents"
            / "models.json"
        )
        self.catalog = VerifiedModelCatalog(
            self.home,
            self.base,
            base_alias_path=self.base_aliases,
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_verified_future_ultrafast_is_exposed_and_keeps_fast(self):
        response = available(
            {
                "modelMessage": "GPT 5.6 Sol",
                "model": "orange-mousse",
                "isDisabled": False,
                "displayGroup": "intelligent",
                "modelCardAttributes": {"speed": 3},
            },
            {
                "modelMessage": "GPT 5.6 Sol Ultrafast",
                "model": "verified-ultrafast-id",
                "isDisabled": False,
                "displayGroup": "fast",
                "modelCardAttributes": {"speed": 5},
            },
        )
        clients = [FakeClient(response), FakeClient(response), FakeClient(response)]
        self.assertTrue(asyncio.run(self.catalog.refresh(clients)))
        self.assertIn("gpt-5.6-sol-ultrafast", self.catalog.model_ids())
        generated = json.loads(
            (self.home / "codex-models.json").read_text(encoding="utf-8")
        )
        future = next(
            item
            for item in generated["models"]
            if item["slug"] == "gpt-5.6-sol-ultrafast"
        )
        self.assertEqual(
            [tier["id"] for tier in future["service_tiers"]], ["priority"]
        )
        aliases = json.loads(
            (self.home / "models.json").read_text(encoding="utf-8")
        )
        self.assertIn("fable-5", aliases["friendly_aliases"])
        self.assertIn("gpt-5.6-sol", aliases["friendly_aliases"])
        self.assertIn("opus-5", aliases["friendly_aliases"])
        self.assertEqual(
            aliases["friendly_aliases"]["gpt-5.6-sol-ultrafast"],
            "verified-ultrafast-id",
        )
        self.assertTrue(all(client._user_map_cache is None for client in clients))

    def test_invented_alias_is_not_exposed(self):
        response = available(("GPT 5.6 Sol", "orange-mousse"))
        self.assertTrue(asyncio.run(self.catalog.refresh([FakeClient(response)])))
        self.assertNotIn("gpt-5.6-sol-ultrafast", self.catalog.model_ids())

    def test_account_disagreement_is_not_exposed(self):
        first = available(("GPT 5.6 Sol Ultrafast", "id-a"))
        second = available(("GPT 5.6 Sol Ultrafast", "id-b"))
        self.assertTrue(
            asyncio.run(self.catalog.refresh([FakeClient(first), FakeClient(second)]))
        )
        self.assertNotIn("gpt-5.6-sol-ultrafast", self.catalog.model_ids())

    def test_gradual_future_model_rollout_is_exposed_and_capabilities_are_recorded(self):
        common = available(("GPT 5.6 Sol", "orange-mousse"))
        early = available(
            ("GPT 5.6 Sol", "orange-mousse"),
            ("GPT 6.0 Pro", "gpt6-id"),
        )
        clients = [FakeClient(common), FakeClient(early)]
        self.assertTrue(asyncio.run(self.catalog.refresh(clients)))
        self.assertIn("gpt-6.0-pro", self.catalog.model_ids())
        self.assertNotIn("gpt-6.0-pro", clients[0]._notion_available_model_aliases)
        self.assertIn("gpt-6.0-pro", clients[1]._notion_available_model_aliases)
        self.assertEqual(self.catalog.status()["partially_available_models"], 1)

    def test_refresh_failure_preserves_base_models(self):
        self.assertFalse(
            asyncio.run(
                self.catalog.refresh([FakeClient(error=RuntimeError("offline"))])
            )
        )
        self.assertEqual(self.catalog.model_ids(), BASE_MODEL_IDS)
        self.assertEqual(self.catalog.status()["state"], "degraded")

    def test_partial_refresh_applies_verified_accounts_without_inferring_failed_account_support(self):
        successful = FakeClient(
            available(
                ("GPT 5.6 Sol", "orange-mousse"),
                ("GPT 6.0 Pro", "gpt6-id"),
            )
        )
        failed = FakeClient(error=RuntimeError("offline"))

        self.assertFalse(asyncio.run(self.catalog.refresh([successful, failed])))
        self.assertIn("gpt-6.0-pro", self.catalog.model_ids())
        self.assertIn("gpt-6.0-pro", successful._notion_available_model_aliases)
        self.assertEqual(failed._notion_available_model_aliases, frozenset())
        status = self.catalog.status()
        self.assertEqual(status["state"], "degraded")
        self.assertEqual(status["verified_accounts"], 1)
        self.assertEqual(status["dynamic_models"], 1)
        self.assertEqual(status["last_error"], "account_refresh_failed")

    def test_fast_model_for_prefers_verified_same_prefix_variant(self):
        response = available(
            {"modelMessage": "GPT 5.6 Sol", "model": "orange-mousse", "isDisabled": False, "displayGroup": "intelligent", "modelCardAttributes": {"speed": 3}},
            {"modelMessage": "GPT 5.6 Luna", "model": "olive-jellyroll", "isDisabled": False, "displayGroup": "fast", "modelCardAttributes": {"speed": 5}},
            {"modelMessage": "Gemini 3 Flash", "model": "gingerbread", "isDisabled": False, "displayGroup": "fast", "modelCardAttributes": {"speed": 5}},
        )
        clients = [FakeClient(response), FakeClient(response)]
        self.assertTrue(asyncio.run(self.catalog.refresh(clients)))
        self.assertEqual(self.catalog.fast_model_for("gpt-5.6-sol"), "gpt-5.6-luna")
        self.assertIsNone(self.catalog.tier_model_for("gpt-5.6-sol", "priority"))
        self.assertIsNone(self.catalog.fast_model_for("opus-5"))


    def test_ultrafast_tier_keeps_selected_base_model_even_when_verified_variant_exists(self):
        response = available(
            ("GPT 5.6 Sol", "orange-mousse"),
            {"modelMessage": "GPT 5.6 Luna", "model": "olive-jellyroll", "isDisabled": False, "displayGroup": "fast", "modelCardAttributes": {"speed": 5}},
            {"modelMessage": "GPT 5.6 Sol Ultrafast", "model": "verified-ultrafast-id", "isDisabled": False, "displayGroup": "fast", "modelCardAttributes": {"speed": 6}},
        )
        clients = [FakeClient(response), FakeClient(response)]
        self.assertTrue(asyncio.run(self.catalog.refresh(clients)))
        self.assertEqual(self.catalog.fast_model_for("gpt-5.6-sol"), "gpt-5.6-luna")
        self.assertIsNone(self.catalog.tier_model_for("gpt-5.6-sol", "ultrafast"))

    def test_verified_future_gpt_model_keeps_only_released_speed_tiers(self):
        response = available(("GPT 6.0 Pro", "gpt6-id"))
        clients = [FakeClient(response), FakeClient(response)]
        self.assertTrue(asyncio.run(self.catalog.refresh(clients)))
        generated = json.loads((self.home / "codex-models.json").read_text(encoding="utf-8"))
        future = next(item for item in generated["models"] if item["slug"] == "gpt-6.0-pro")
        self.assertEqual([tier["id"] for tier in future["service_tiers"]], ["priority"])

    def test_explicitly_advertised_ultrafast_tier_is_enabled_automatically(self):
        response = available(
            {
                "modelMessage": "GPT 6.0 Pro",
                "model": "gpt6-id",
                "isDisabled": False,
                "serviceTiers": ["priority", "ultrafast"],
            }
        )
        clients = [FakeClient(response), FakeClient(response)]
        self.assertTrue(asyncio.run(self.catalog.refresh(clients)))
        generated = json.loads((self.home / "codex-models.json").read_text(encoding="utf-8"))
        future = next(item for item in generated["models"] if item["slug"] == "gpt-6.0-pro")
        self.assertEqual(
            [tier["id"] for tier in future["service_tiers"]],
            ["priority", "ultrafast"],
        )
        self.assertTrue(self.catalog.supports_service_tier("gpt-6.0-pro", "ultrafast"))


if __name__ == "__main__":
    unittest.main()
