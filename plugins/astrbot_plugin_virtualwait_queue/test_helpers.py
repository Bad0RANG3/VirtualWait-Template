import sys
import unittest
from pathlib import Path

# Keep this standalone plugin test runnable from the repository root as well
# as from AstrBot's plugin directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from helpers import build_head_key, resolve_umo, build_notify_text


class HelperTests(unittest.TestCase):
    def test_head_key_sorts(self):
        self.assertEqual(
            build_head_key("m1", [{"qq": "200"}, {"qq": "100"}, {"qq": None}]),
            "m1_100_200",
        )

    def test_resolve_priority(self):
        self.assertEqual(
            resolve_umo(
                api_group_umo="api",
                venue_slug="v1",
                district_slug="d1",
                routing={"v1": "r"},
                district_routing={"district:d1": "d"},
                default_umo="def",
            ),
            "api",
        )
        self.assertEqual(
            resolve_umo(
                api_group_umo="",
                venue_slug="v1",
                district_slug="d1",
                routing={"v1": "r"},
                district_routing={"district:d1": "d"},
                default_umo="def",
            ),
            "r",
        )
        self.assertEqual(
            resolve_umo(
                api_group_umo=None,
                venue_slug="v-x",
                district_slug="d1",
                routing={},
                district_routing={"district:d1": "d"},
                default_umo="def",
            ),
            "d",
        )

    def test_duo_text(self):
        text = build_notify_text(
            players=[
                {"displayName": "甲", "qq": "1"},
                {"displayName": "乙", "qq": "2"},
            ],
            district_name="示例区",
            venue_name="中心店",
            machine_name="机台A",
        )
        self.assertIn("您与【乙】", text)
        self.assertIn("机台A", text)


if __name__ == "__main__":
    unittest.main()
