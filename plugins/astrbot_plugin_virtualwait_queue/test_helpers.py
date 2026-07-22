import sys
import unittest
from pathlib import Path

# Keep this standalone plugin test runnable from the repository root as well
# as from AstrBot's plugin directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from helpers import build_call_reminder, build_head_key, build_queue_status_text, resolve_umo


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

    def test_queue_status_preserves_duo_position_and_empty_name(self):
        text = build_queue_status_text(
            city_name="示例市",
            district_name="示例区",
            venue_name="中心店",
            waiting_queue=[
                {"position": 1, "players": [{"displayName": "甲", "qq": "1"}]},
                {
                    "position": 2,
                    "players": [
                        {"displayName": "乙", "qq": "2"},
                        {"displayName": "", "qq": "3"},
                    ],
                },
            ],
        )
        self.assertEqual(
            text,
            "示例市示例区中心店队伍情况：\n\n1、甲\n2、乙、未命名玩家",
        )

    def test_empty_queue_and_default_reminder(self):
        self.assertIn(
            "当前暂无等待玩家",
            build_queue_status_text(
                city_name="",
                district_name="",
                venue_name="",
                waiting_queue=[],
            ),
        )
        self.assertEqual(build_call_reminder(), "，请在3分钟内上机游玩")


if __name__ == "__main__":
    unittest.main()
