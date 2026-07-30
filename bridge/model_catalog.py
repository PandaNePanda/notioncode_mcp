from __future__ import annotations

import asyncio
import copy
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable

BASE_MODEL_IDS = ("fable-5", "gpt-5.6-sol", "opus-5")
BASE_DISPLAY_NAMES = {
    "fable-5": "Fable 5 (Notion)",
    "gpt-5.6-sol": "GPT-5.6 Sol (Notion)",
    "opus-5": "Opus 5 (Notion)",
}


def _alias_from_model_message(message: str) -> str:
    return message.strip().lower().replace(" ", "-")


def _parse_available_model_details(response: dict[str, Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for entry in response.get("models") or []:
        if not isinstance(entry, dict) or entry.get("isDisabled"):
            continue
        message = entry.get("modelMessage")
        internal_id = entry.get("model")
        if not isinstance(message, str) or not isinstance(internal_id, str):
            continue
        alias = _alias_from_model_message(message)
        if not alias:
            continue
        details: dict[str, Any] = {"internal_id": internal_id}
        display_group = entry.get("displayGroup")
        if isinstance(display_group, str) and display_group.strip():
            details["display_group"] = display_group.strip().lower()
        model_card_attributes = entry.get("modelCardAttributes")
        if isinstance(model_card_attributes, dict):
            speed = model_card_attributes.get("speed")
            if isinstance(speed, int):
                details["speed"] = speed
        advertised_tiers: set[str] = set()
        for key in (
            "serviceTiers",
            "service_tiers",
            "supportedServiceTiers",
            "supported_service_tiers",
        ):
            value = entry.get(key)
            if not isinstance(value, list):
                continue
            for tier in value:
                tier_id = tier.get("id") if isinstance(tier, dict) else tier
                if not isinstance(tier_id, str):
                    continue
                normalized = tier_id.strip().lower()
                if normalized == "fast":
                    normalized = "priority"
                if normalized in {"priority", "ultrafast"}:
                    advertised_tiers.add(normalized)
        if advertised_tiers:
            details["service_tiers"] = tuple(sorted(advertised_tiers))
        out[alias] = details
    return out


def _same_model_signature(left: dict[str, Any] | None, right: dict[str, Any]) -> bool:
    return (
        isinstance(left, dict)
        and left.get("internal_id") == right.get("internal_id")
    )


def _fast_group_prefix(alias: str) -> str:
    head, _, _tail = alias.rpartition("-")
    return head or alias


def _display_name(alias: str) -> str:
    rendered: list[str] = []
    for word in alias.replace("_", "-").split("-"):
        lower = word.lower()
        if lower == "gpt":
            rendered.append("GPT")
        elif lower in {"ai", "oss"}:
            rendered.append(lower.upper())
        elif word:
            rendered.append(word[:1].upper() + word[1:])
    return " ".join(rendered) + " (Notion)"


def _atomic_json_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    if os.name != "nt":
        temporary.chmod(0o600)
    os.replace(temporary, path)


class VerifiedModelCatalog:
    """Expose models authoritatively returned by at least one eligible account.

    New models are often enabled gradually. Requiring every configured account
    to report a model hid legitimate rollouts until the slowest account gained
    access. Conflicting internal IDs are still rejected, and each client is
    annotated with its own advertised aliases so the account pool can route a
    selected model only to accounts that actually support it.
    """

    def __init__(
        self,
        account_home: Path,
        base_catalog_path: Path,
        *,
        base_alias_path: Path | None = None,
        base_model_ids: tuple[str, ...] = BASE_MODEL_IDS,
        base_display_names: dict[str, str] | None = None,
    ) -> None:
        self.account_home = account_home
        self.alias_path = account_home / "models.json"
        self.codex_catalog_path = account_home / "codex-models.json"
        self.base_catalog_path = base_catalog_path
        self.base_alias_path = base_alias_path
        self.base_model_ids = base_model_ids
        self.base_display_names = dict(base_display_names or BASE_DISPLAY_NAMES)
        self._dynamic_aliases: dict[str, str] = {}
        self._verified_model_details: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()
        self._status: dict[str, Any] = {
            "state": "pending",
            "verified_accounts": 0,
            "dynamic_models": 0,
            "last_success_at": None,
            "last_error": None,
        }

    def model_ids(self) -> tuple[str, ...]:
        dynamic = sorted(
            alias for alias in self._dynamic_aliases if alias not in self.base_model_ids
        )
        return (*self.base_model_ids, *dynamic)

    def display_name(self, model_id: str) -> str:
        return self.base_display_names.get(model_id, _display_name(model_id))

    def notion_model_for(self, model_id: str) -> str | None:
        dynamic = self._dynamic_aliases.get(model_id)
        if isinstance(dynamic, str) and dynamic:
            return dynamic
        verified = self._verified_model_details.get(model_id)
        internal_id = verified.get("internal_id") if isinstance(verified, dict) else None
        if isinstance(internal_id, str) and internal_id:
            return internal_id
        base = self._base_aliases().get(model_id)
        if isinstance(base, str) and base:
            return base
        return None

    def model_entries(self) -> list[dict[str, Any]]:
        for path in (self.codex_catalog_path, self.base_catalog_path):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            models = payload.get("models")
            if not isinstance(models, list):
                continue
            entries = [copy.deepcopy(item) for item in models if isinstance(item, dict)]
            if entries:
                # Generated catalogs can outlive a bridge upgrade. Re-apply the
                # currently verified tier capabilities when reading so stale
                # metadata cannot keep an unreleased Ultrafast option visible.
                for item in entries:
                    slug = item.get("slug")
                    if isinstance(slug, str):
                        self._apply_verified_service_tiers(slug, item)
                return entries
        return [
            {
                "slug": model_id,
                "model": model_id,
                "display_name": self.display_name(model_id),
                "displayName": self.display_name(model_id),
            }
            for model_id in self.model_ids()
        ]

    def status(self) -> dict[str, Any]:
        return dict(self._status)

    async def refresh(self, clients: Iterable[Any]) -> bool:
        client_list = list(clients)
        if not client_list:
            self._status.update(
                state="no_accounts", verified_accounts=0, last_error="no_accounts"
            )
            return False

        async with self._lock:
            results = await asyncio.gather(
                *(client.fetch_available_models() for client in client_list),
                return_exceptions=True,
            )
            successful: list[tuple[Any, dict[str, dict[str, Any]]]] = []
            failures = 0
            for client, result in zip(client_list, results, strict=True):
                if isinstance(result, BaseException):
                    failures += 1
                    client._notion_available_model_aliases = frozenset()
                else:
                    successful.append((client, _parse_available_model_details(result)))

            if not successful:
                self._status.update(
                    state="degraded",
                    verified_accounts=0,
                    last_error="account_refresh_failed",
                )
                return False

            parsed = [mapping for _client, mapping in successful]

            verified_details: dict[str, dict[str, Any]] = {}
            support_counts: dict[str, int] = {}
            candidate_aliases = set().union(*(mapping.keys() for mapping in parsed))
            for alias in candidate_aliases:
                advertised = [mapping[alias] for mapping in parsed if alias in mapping]
                if not advertised:
                    continue
                # A model may be absent from accounts that have not received the
                # rollout yet, but two accounts must never disagree about what a
                # friendly alias means.
                if all(_same_model_signature(details, advertised[0]) for details in advertised[1:]):
                    merged = copy.deepcopy(advertised[0])
                    service_tiers = sorted(
                        {
                            tier
                            for details in advertised
                            for tier in details.get("service_tiers", ())
                        }
                    )
                    if service_tiers:
                        merged["service_tiers"] = tuple(service_tiers)
                    verified_details[alias] = merged
                    support_counts[alias] = len(advertised)
            aliases = {
                alias: str(details["internal_id"])
                for alias, details in verified_details.items()
            }
            aliases_to_write = {**self._base_aliases(), **aliases}
            self._verified_model_details = verified_details
            self._write_aliases(aliases_to_write)
            self._write_codex_catalog(aliases)
            self._dynamic_aliases = aliases_to_write
            for client, mapping in successful:
                client._notion_available_model_aliases = frozenset(mapping)
                # The provider caches the per-user alias map. Refreshing the
                # verified catalog must invalidate it so newly advertised
                # models and internal IDs are used on later requests.
                if hasattr(client, "_user_map_cache"):
                    client._user_map_cache = None
            self._status.update(
                state="degraded" if failures else "ok",
                verified_accounts=len(parsed),
                dynamic_models=sum(
                    alias not in self.base_model_ids for alias in aliases
                ),
                partially_available_models=sum(
                    count < len(client_list) for count in support_counts.values()
                ),
                last_success_at=datetime.now(UTC).isoformat(timespec="seconds"),
                last_error="account_refresh_failed" if failures else None,
            )
            return failures == 0

    def fast_model_for(self, model_id: str) -> str | None:
        prefix = _fast_group_prefix(model_id)
        candidates: list[tuple[int, str]] = []
        for alias, details in self._verified_model_details.items():
            if alias == model_id or details.get("display_group") != "fast":
                continue
            if not alias.startswith(prefix):
                continue
            haystack = alias.replace("_", "").replace("-", "").lower()
            if "ultrafast" in haystack:
                continue
            speed = details.get("speed")
            candidates.append((speed if isinstance(speed, int) else -1, alias))
        if not candidates:
            return None
        candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
        return candidates[0][1]

    def tier_model_for(self, model_id: str, service_tier: str | None) -> str | None:
        if not isinstance(service_tier, str) or not service_tier.strip():
            return None
        tier = service_tier.strip().lower()
        if tier in {"priority", "fast", "ultrafast"}:
            # Speed tiers must stay on the model the user explicitly selected.
            # Verified sibling models such as Luna, Terra, or a future
            # "...-ultrafast" alias may still appear as separate explicit model
            # choices in the catalog, but choosing a speed tier must not swap the
            # model behind the user's back.
            return None
        return None

    def supports_service_tier(self, model_id: str, service_tier: str | None) -> bool:
        if not isinstance(service_tier, str):
            return False
        tier = service_tier.strip().lower()
        if tier == "fast":
            tier = "priority"
        if tier == "priority":
            return True
        details = self._verified_model_details.get(model_id)
        return (
            tier == "ultrafast"
            and isinstance(details, dict)
            and tier in details.get("service_tiers", ())
        )

    def _apply_verified_service_tiers(
        self, model_id: str, item: dict[str, Any]
    ) -> None:
        tiers = item.get("service_tiers")
        if isinstance(tiers, list):
            tiers = [
                tier
                for tier in tiers
                if not isinstance(tier, dict) or tier.get("id") != "ultrafast"
            ]
            if self.supports_service_tier(model_id, "ultrafast"):
                tiers.append(
                    {
                        "id": "ultrafast",
                        "name": "Ultrafast",
                        "description": (
                            "Keeps the selected model and requests the provider "
                            "ultrafast tier verified in live model metadata"
                        ),
                    }
                )
            item["service_tiers"] = tiers
        additional = item.get("additional_speed_tiers")
        if isinstance(additional, list):
            additional = [tier for tier in additional if tier != "ultrafast"]
            if self.supports_service_tier(model_id, "ultrafast"):
                additional.append("ultrafast")
            item["additional_speed_tiers"] = additional

    def _base_aliases(self) -> dict[str, str]:
        if self.base_alias_path is None or not self.base_alias_path.is_file():
            return {}
        try:
            payload = json.loads(self.base_alias_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        aliases = payload.get("friendly_aliases")
        if not isinstance(aliases, dict):
            return {}
        return {
            alias: internal_id
            for alias, internal_id in aliases.items()
            if alias in self.base_model_ids
            and isinstance(internal_id, str)
            and internal_id
        }

    def _write_aliases(self, aliases: dict[str, str]) -> None:
        _atomic_json_write(
            self.alias_path,
            {
                "friendly_aliases": dict(sorted(aliases.items())),
                "updated_at": datetime.now(UTC).isoformat(timespec="seconds"),
            },
        )

    def _write_codex_catalog(self, aliases: dict[str, str]) -> None:
        base = json.loads(self.base_catalog_path.read_text(encoding="utf-8"))
        models = base.get("models")
        if not isinstance(models, list):
            raise ValueError("base Codex model catalog has no models array")
        by_slug = {
            item.get("slug"): item for item in models if isinstance(item, dict)
        }
        for slug, item in by_slug.items():
            if isinstance(slug, str):
                self._apply_verified_service_tiers(slug, item)
        next_priority = max(
            (int(item.get("priority", 0)) for item in models if isinstance(item, dict)),
            default=0,
        ) + 1
        for alias in sorted(aliases):
            if alias in self.base_model_ids or alias in by_slug:
                continue
            if alias.startswith("gpt-"):
                template_slug = "gpt-5.6-sol"
            elif "opus" in alias:
                template_slug = "opus-5"
            else:
                template_slug = "gpt-5.5"
            template = by_slug.get(template_slug)
            if not isinstance(template, dict):
                continue
            item = copy.deepcopy(template)
            name = _display_name(alias)
            item.update(
                slug=alias,
                model=alias,
                display_name=name,
                displayName=name,
                description=(
                    f"Notion {name.removesuffix(' (Notion)')} through the local bridge."
                ),
                priority=next_priority,
            )
            next_priority += 1
            details = self._verified_model_details.get(alias, {})
            keep_speed_tiers = alias.startswith("gpt-") or details.get("display_group") == "fast"
            if not keep_speed_tiers:
                item.pop("additional_speed_tiers", None)
                item.pop("service_tiers", None)
            else:
                self._apply_verified_service_tiers(alias, item)
            models.append(item)
        _atomic_json_write(self.codex_catalog_path, base)
